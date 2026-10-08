import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

const denied4 = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],
  ['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) denied4.addSubnet(address,prefix,'ipv4');
const public6 = new net.BlockList(); public6.addSubnet('2000::',3,'ipv6');
const denied6 = new net.BlockList();
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) denied6.addSubnet(address,prefix,'ipv6');
export function publicAddress(address) {
  const family=net.isIP(address);
  return family===4?!denied4.check(address,'ipv4'):family===6&&public6.check(address,'ipv6')&&!denied6.check(address,'ipv6');
}
export function destination(value, trustedHosts) {
  if(typeof value!=='string'||value.length>2048||/[\s\\\x00-\x1f]/.test(value))throw new Error('unsafe_callback');
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!trustedHosts.includes(url.hostname)||net.isIP(url.hostname))throw new Error('unsafe_callback');
  return url;
}
export async function pinnedPost(value, headers, body, options={}) {
  const {trustedHosts=[],resolver=host=>dns.lookup(host,{all:true,verbatim:true}),request=https.request,timeoutMs=10000,signal}=options;
  if(signal?.aborted)throw new Error('callback_cancelled');
  const url=destination(value,trustedHosts);
  if(typeof body!=='string'||Buffer.byteLength(body)>262144)throw new Error('payload_too_large');
  const required=['webhook-id','webhook-timestamp','webhook-signature','X-MCP-Subscription-Id'];
  if(required.some(k=>typeof headers?.[k]!=='string'||/[\r\n]/.test(headers[k])||headers[k].length>2048))throw new Error('invalid_headers');
  const deadline=Date.now()+timeoutMs;
  let timer,abortDNS;
  const addresses=await Promise.race([
    resolver(url.hostname),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),timeoutMs);}),
    new Promise((_,reject)=>{abortDNS=()=>reject(new Error('callback_cancelled'));signal?.addEventListener('abort',abortDNS,{once:true});if(signal?.aborted)abortDNS();})
  ]).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abortDNS);});
  if(signal?.aborted)throw new Error('callback_cancelled');
  if(!Array.isArray(addresses)||!addresses.length||addresses.some(x=>!publicAddress(x.address)))throw new Error('unsafe_address');
  const chosen=addresses[0];
  if(Date.now()>=deadline)throw new Error('timeout');
  return await new Promise((resolve,reject)=>{
    const forwarded=Object.fromEntries(required.map(k=>[k,headers[k]]));
    Object.assign(forwarded,{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body))});
    // Never resolve the hostname a second time. TLS SNI and certificate
    // identity stay on the original hostname while lookup pins the IP.
    const req=request(url,{method:'POST',headers:forwarded,agent:false,servername:url.hostname,
      rejectUnauthorized:true,minVersion:'TLSv1.2',lookup:(_host,lookupOptions,done)=>{
        if(lookupOptions?.all)done(null,[chosen]);else done(null,chosen.address,chosen.family);
      }},res=>{
        let size=0;const chunks=[];
        res.on('data',chunk=>{size+=chunk.length;if(size>4096){reject(new Error('response_too_large'));res.destroy?.();req.destroy(new Error('response_too_large'));return;}chunks.push(chunk);});
        res.on('error',()=>reject(new Error('response_error')));
        res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
      });
    const deadlineTimer=setTimeout(()=>req.destroy(new Error('timeout')),Math.max(1,deadline-Date.now()));
    const abortRequest=()=>req.destroy(new Error('callback_cancelled'));
    signal?.addEventListener('abort',abortRequest,{once:true});
    req.on('close',()=>{clearTimeout(deadlineTimer);signal?.removeEventListener('abort',abortRequest);});
    req.on('error',()=>reject(new Error('callback_endpoint_error')));
    if(signal?.aborted){abortRequest();return;}
    req.end(body); // https.request does not follow any redirects.
  });
}
