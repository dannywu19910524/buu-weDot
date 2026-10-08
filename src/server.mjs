import http from 'node:http';
import {isMain} from './private-files.mjs';
import {readConfig} from './config.mjs';
import {MessageStore} from './store.mjs';
import {Bridge} from './bridge.mjs';
import {MCP_BODY_LIMIT} from './features.mjs';
import {handler} from './http.mjs';
export async function serve(file){
  const {config:c,auth,key,binding,clientVersion}=readConfig(file);let adapter,bridge;const jobs=new Set();let closing=false,closeJob;
  const server=http.createServer(async(req,res)=>{
    if(closing||!bridge){res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"unavailable"}');return;}
    const job=(async()=>{try{
      const allowedHosts=[new URL(c.resource).host,(c.listen.host==='::1'?'[::1]':c.listen.host)+':'+c.listen.port];if(!allowedHosts.includes(req.headers.host))throw 0;
      // Media requests can be larger than text RPCs. Reject an unauthenticated
      // caller before buffering any request bytes; the handler rechecks after
      // body parsing and after awaited work as well.
      const target=new URL(req.url,new URL(c.resource).origin);
      if(req.method==='POST'&&target.pathname===new URL(c.resource).pathname){try{const identity=bridge.auth.verify(new Request(target,{method:req.method,headers:req.headers}));if(identity.ownerHash!==adapter.ownerHash)throw 0;}catch{const response=await handler(bridge)(new Request(target,{method:req.method,headers:req.headers}));res.writeHead(response.status,Object.fromEntries(response.headers));req.resume();res.end(Buffer.from(await response.arrayBuffer()));return;}}
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MCP_BODY_LIMIT)throw 0;chunks.push(chunk);}
      const request=new Request(new URL(req.url,new URL(c.resource).origin),{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
      const response=await handler(bridge)(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{if(!res.headersSent)res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"request_rejected"}');}})();jobs.add(job);job.finally(()=>jobs.delete(job)).catch(()=>{});
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  try{
    // Fail occupied ports before opening/migrating the durable business store.
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.listen.port,c.listen.host,resolve);});
    adapter=new MessageStore({mode:c.mode,enableReal:c.real?.enable===true,binding,dbPath:c.state.database,key,ownerHash:auth.ownerHash,clientVersion,features:c.features});
    bridge=new Bridge({adapter,auth,mode:c.mode,callbackHosts:c.callbackHosts});bridge.start();
  }catch(e){await bridge?.close();if(adapter&&!bridge)await adapter.close();await new Promise(r=>server.close(r));throw e;}finally{key.fill(0);}
  const close=()=>closeJob??=(async()=>{closing=true;bridge.invalidate();adapter.stop();await Promise.allSettled([...jobs]);await bridge.close();await new Promise(r=>server.close(r));})();
  return {close,address:server.address()};
}
if(isMain(import.meta.url)){
  const i=process.argv.indexOf('--config'),file=i>=0?process.argv[i+1]:undefined;
  if(!file){console.error('Usage: node src/server.mjs --config PRIVATE_CONFIG');process.exitCode=1;}
  else try{const app=await serve(file);for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void app.close().then(()=>{process.exitCode=0;}).catch(()=>{process.exitCode=1;});});console.log(JSON.stringify({ready:true}));}catch{console.error('Startup rejected; check private configuration, writer lock and storage permissions.');process.exitCode=1;}
}
