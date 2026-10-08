import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {pinnedPost,publicAddress} from '../src/pinned-https.mjs';
import {pinnedJSON,parseWeixinJSON,messageID} from '../src/weixin-transport.mjs';
const publicDNS=async()=>[{address:'93.184.216.34',family:4}];
const headers={'webhook-id':'fixture-event','webhook-timestamp':'1700000000','webhook-signature':'fixture-signature','X-MCP-Subscription-Id':'fixture-subscription'};
function requestStub({status=200,body='{}',inspect}={}){return (url,options,callback)=>{inspect?.(url,options);const req=new EventEmitter();req.destroy=error=>{queueMicrotask(()=>{if(error)req.emit('error',error);req.emit('close');});};req.end=()=>{const res=new EventEmitter();res.statusCode=status;res.resume=()=>{};res.destroy=()=>{};queueMicrotask(()=>{callback(res);res.emit('data',Buffer.from(body));res.emit('end');req.emit('close');});};return req;};}
test('lossless source JSON recovers uint64 ID digits and refuses rounded numeric input',()=>{
  assert.equal(parseWeixinJSON('{"message_id":18446744073709551615}').message_id,'18446744073709551615');assert.equal(messageID(18446744073709551615),null);assert.equal(messageID('18446744073709551616'),null);assert.equal(messageID(-0),null);assert.equal(messageID('01'),null);
});
test('private, loopback, reserved and mapped IPv6 addresses are blocked',()=>{
  for(const address of ['127.0.0.1','10.0.0.1','192.168.0.1','169.254.169.254','100.64.0.1','192.0.2.1','::1','::ffff:127.0.0.1','2001:db8::1','fc00::1'])assert.equal(!!publicAddress(address),false,address);
  assert.equal(publicAddress('93.184.216.34'),true);assert.equal(publicAddress('2606:4700::1111'),true);
});
test('mixed DNS answers reject callback and provider before any socket opens',async()=>{
  let sockets=0;const resolver=async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}],request=()=>{sockets++;throw 0;};
  await assert.rejects(pinnedPost('https://callbacks.example.com/event',headers,'{}',{trustedHosts:['callbacks.example.com'],resolver,request}));await assert.rejects(pinnedJSON('https://ilinkai.weixin.qq.com/ilink/bot/getupdates',{resolver,request}));assert.equal(sockets,0);
});
test('HTTPS callback pins one DNS result while preserving TLS host and forbids redirects',async()=>{
  let sockets=0;const request=requestStub({status:302,body:'',inspect:(url,p)=>{sockets++;assert.equal(url.hostname,'callbacks.example.com');assert.equal(p.servername,url.hostname);assert.equal(p.rejectUnauthorized,true);p.lookup(url.hostname,{},(err,address)=>{assert.equal(err,null);assert.equal(address,'93.184.216.34');});}});
  const response=await pinnedPost('https://callbacks.example.com/event',headers,'{}',{trustedHosts:['callbacks.example.com'],resolver:publicDNS,request});assert.equal(response.status,302);assert.equal(sockets,1);
});
test('provider redirects reject without following and auth URL fields are rejected',async()=>{
  let sockets=0;await assert.rejects(pinnedJSON('https://ilinkai.weixin.qq.com/ilink/bot/getupdates',{resolver:publicDNS,request:requestStub({status:302,inspect:()=>sockets++})}),/http_rejected/);assert.equal(sockets,1);
  const credentialURL=new URL('https://ilinkai.weixin.qq.com/');credentialURL.username='REPLACE_WITH_USERNAME';credentialURL.password='REPLACE_WITH_PASSWORD';
  for(const url of ['https://foreign.example.com/','http://ilinkai.weixin.qq.com/',credentialURL.href,'https://ilinkai.weixin.qq.com/#fragment'])await assert.rejects(pinnedJSON(url,{resolver:publicDNS,request:()=>{throw new Error('must not open');}}));
});
test('DNS cancellation returns promptly and a late answer never opens a socket',async()=>{
  let finish,sockets=0;const signal=new AbortController(),resolver=()=>new Promise(r=>finish=r);
  const pending=pinnedPost('https://callbacks.example.com/event',headers,'{}',{trustedHosts:['callbacks.example.com'],resolver,signal:signal.signal,request:()=>sockets++});signal.abort();await assert.rejects(pending);finish(await publicDNS());await Promise.resolve();assert.equal(sockets,0);
});
test('callback response limits and provider lossless response parsing use bounded transports',async()=>{
  await assert.rejects(pinnedPost('https://callbacks.example.com/event',headers,'{}',{trustedHosts:['callbacks.example.com'],resolver:publicDNS,request:requestStub({body:'x'.repeat(4097)})}),/response_too_large/);
  const response=await pinnedJSON('https://ilinkai.weixin.qq.com/ilink/bot/getupdates',{resolver:publicDNS,request:requestStub({body:'{"message_id":18446744073709551615}'})});assert.equal(response.message_id,'18446744073709551615');
});
