import dns from 'node:dns/promises';
import https from 'node:https';
import {publicAddress} from './pinned-https.mjs';
export const API_HOST='ilinkai.weixin.qq.com';
export const HTTP_STATUS=Symbol('weixin-http-status');
const ID_FIELDS=new Set(['message_id','msg_id','svr_id']);
// Node 24's source-aware JSON reviver sees the original number token, before
// its rounded Number value is used. Never recover an ID from that Number.
export function parseWeixinJSON(raw){
  const parsed=JSON.parse(raw,(key,value,context)=>{
    if(ID_FIELDS.has(key)&&typeof value==='number'){
      if(typeof context?.source!=='string')throw new Error('lossless_parser_required');
      return context.source;
    }
    return value;
  });
  if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new Error('invalid_response');return parsed;
}
export function messageID(value){
  if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0||Object.is(value,-0))return null;value=String(value);}
  if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(value)||BigInt(value)>18446744073709551615n)return null;
  return value;
}
export function apiBase(value,hosts=[API_HOST]){
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!['','/'].includes(u.pathname)||!hosts.includes(u.hostname))throw new Error('api_host_rejected');
  return u.origin;
}
export async function pinnedJSON(value,{method='POST',headers={},body,signal,timeoutMs=40000,hosts=[API_HOST],resolver=host=>dns.lookup(host,{all:true,verbatim:true}),request=https.request}={}){
  const u=new URL(value);apiBase(u.origin,hosts);if(u.username||u.password||u.hash)throw new Error('request_rejected');
  if(!['POST','GET'].includes(method)||Buffer.byteLength(body??'')>262144)throw new Error('request_rejected');
  if(signal?.aborted)throw new Error('cancelled');
  const deadline=Date.now()+timeoutMs;let timer,abortDNS;
  // DNS may outlive its caller. Stop waiting immediately on cancellation and
  // fence its late result so it can never open a request after a pulse ends.
  const records=await new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error('timeout')),timeoutMs);
    abortDNS=()=>reject(new Error('cancelled'));
    signal?.addEventListener('abort',abortDNS,{once:true});
    if(signal?.aborted){abortDNS();return;}
    Promise.resolve(resolver(u.hostname)).then(resolve,reject);
  }).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abortDNS);});
  if(signal?.aborted)throw new Error('cancelled');
  if(Date.now()>=deadline)throw new Error('timeout');
  if(!records?.length||records.some(r=>!publicAddress(r.address)))throw new Error('address_rejected');
  const chosen=records[0];
  return new Promise((resolve,reject)=>{
    let responseStatus,terminationReason;
    const failure=reason=>{const error=new Error(reason);if(responseStatus!==undefined)error.statusCode=responseStatus;return error;};
    const req=request(u,{method,agent:false,headers:{...headers,...(body?{'Content-Length':String(Buffer.byteLength(body))}:{})},minVersion:'TLSv1.2',rejectUnauthorized:true,servername:u.hostname,
      lookup:(_host,opt,cb)=>opt?.all?cb(null,[chosen]):cb(null,chosen.address,chosen.family)},res=>{
      responseStatus=res.statusCode;
      if((res.statusCode??0)<200||res.statusCode>=300){const error=new Error('http_rejected');error.statusCode=res.statusCode;res.resume();req.destroy();reject(error);return;}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>262144){req.destroy();reject(failure('response_too_large'));return;}chunks.push(chunk);});
      res.on('error',()=>reject(failure('response_error')));
      res.on('end',()=>{try{const parsed=parseWeixinJSON(Buffer.concat(chunks).toString());Object.defineProperty(parsed,HTTP_STATUS,{value:res.statusCode});resolve(parsed);}catch{reject(failure('invalid_response'));}});
    });
    const abort=()=>{terminationReason??='cancelled';req.destroy(failure(terminationReason));};
    const stop=setTimeout(()=>{terminationReason??='timeout';req.destroy(failure(terminationReason));},Math.max(1,deadline-Date.now()));
    signal?.addEventListener('abort',abort,{once:true});
    req.on('close',()=>{clearTimeout(stop);signal?.removeEventListener('abort',abort);});
    req.on('error',()=>reject(failure(terminationReason??'transport_error')));
    if(signal?.aborted)abort();else req.end(body); // No redirects or second DNS lookup.
  });
}
