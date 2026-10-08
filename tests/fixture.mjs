import {generateKeyPairSync,randomBytes,sign,createHmac} from 'node:crypto';
import {MessageStore,sha} from '../src/store.mjs';
import {Bridge} from '../src/bridge.mjs';
import {ownerVerifier} from '../src/auth.mjs';
import {imageFixture} from '../src/media.mjs';
import {handler} from '../src/http.mjs';
export const liveFixtures=new Set();
export const epoch=1700000000000,canonicalOwner='fixture-owner',ownerHash=sha(canonicalOwner),issuer='https://identity.example.com',resource='https://bridge.example.com/mcp';
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
export const jwk={...pair.publicKey.export({format:'jwk'}),kid:'fixture-key',alg:'RS256',use:'sig'};
export function jwt({now=epoch,claims={},header={}}={}){const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'at+jwt',kid:jwk.kid,...header})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:issuer,sub:'fixture-subject',aud:resource,scope:'weixin:owner',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+300,...claims})).toString('base64url');return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),pair.privateKey).toString('base64url');}
export function fixture(options={}){
  let now=options.now??epoch,batch=[],signingSecret='whsec_'+randomBytes(32).toString('base64');const callbacks=[],providerCalls=[],timers=[];
  const binding=options.binding??{botToken:randomBytes(32).toString('base64url'),botId:'fixture-bot',ownerPeerId:'fixture-peer',apiBase:'https://ilinkai.weixin.qq.com',boundAtMs:epoch-1000,consent:{persist:true,receive:true,send:true}};
  const auth=ownerVerifier({issuer,resource,subject:'fixture-subject',canonicalOwner,jwks:[jwk],clock:()=>now});
  const a=new MessageStore({features:options.features,imageDownload:options.imageDownload??(async()=>imageFixture()),imageUpload:options.imageUpload??(async()=> 'REPLACE_WITH_DOWNLOAD_PARAMETER'),mode:options.mode??'mock',enableReal:options.mode==='real',binding,ownerHash,key:options.key??randomBytes(32),dbPath:options.dbPath??':memory:',clock:()=>now,schedule:(fn,ms)=>{const t={fn,ms,unref(){}};timers.push(t);return t;},cancelSchedule:t=>{if(t)t.cancelled=true;},provider:async(url,p)=>{providerCalls.push({url,body:JSON.parse(p.body),headers:p.headers});if(options.provider)return options.provider(url,p);if(url.endsWith('/getupdates')){const msgs=batch;batch=[];return {ret:0,msgs,get_updates_buf:'fixture-cursor'};}if(url.endsWith('/getuploadurl'))return {ret:0,upload_param:'REPLACE_WITH_UPLOAD_PARAMETER'};if(url.endsWith('/getconfig'))return {ret:0,typing_ticket:randomBytes(24).toString('base64')};if(url.endsWith('/sendtyping'))return {ret:0};if(url.endsWith('/sendmessage'))return options.send?options.send():{ret:0};throw new Error('unexpected_provider_operation');}});
  const b=new Bridge({adapter:a,auth,mode:options.mode??'mock',callbackHosts:['callbacks.example.com'],callback:async(url,h,body,p)=>{const v=JSON.parse(body),signature='v1,'+createHmac('sha256',Buffer.from(signingSecret.slice(6),'base64')).update(h['webhook-id']+'.'+h['webhook-timestamp']+'.'+body).digest('base64');if(!h['webhook-signature'].split(' ').includes(signature))throw new Error('signature_mismatch');callbacks.push({url,headers:h,body:v,signal:p.signal});return options.callback?options.callback(url,h,body,p):{status:200,body:JSON.stringify(v.type==='verification'?{challenge:v.challenge}:{ok:true})};}});
  const handle=handler(b);let sequence=0;
  const rpc=(method,params={},headers={})=>handle(new Request(resource,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt({now}),...headers},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params})}));
  const call=async(name,args={})=>(await rpc('tools/call',{name,arguments:args})).json();
  const subscribe=async(secret=signingSecret,extra={})=>{signingSecret=secret;const r=await b.subscribe({name:'weixin.message.created',arguments:{binding_id:b.binding},delivery:{mode:'webhook',url:'https://callbacks.example.com/event',secret},...extra});await a.flush();return r;};
  const start=async()=>{b.start();await a.flush();};
  const inject=async(seed='fixture-01',nonce='fixture-01',kind='text')=>{const r=await call('mock_weixin_inbound',{binding_id:b.binding,message_id:seed,nonce,kind});if(r.error)throw new Error(r.error.data.reason);await a.flush();return r.result.structuredContent;};
  const wire=(id='1',extra={})=>({message_id:id,from_user_id:binding.ownerPeerId,to_user_id:binding.botId,message_type:1,message_state:2,create_time_ms:now,context_token:'fixture-context',item_list:[{type:1,text_item:{text:'Synthetic owner text'}}],...extra});
  const receive=async(messages)=>{batch=messages;await a.receiveOnce();await a.flush();};
  const item={dbPath:options.dbPath,close:async()=>{await b.close();liveFixtures.delete(item);}};liveFixtures.add(item);
  return {a,b,auth,handle,rpc,call,subscribe,start,inject,wire,receive,binding,callbacks,providerCalls,timers,key:()=>signingSecret,now:()=>now,advance:n=>now+=n,close:item.close};
}
