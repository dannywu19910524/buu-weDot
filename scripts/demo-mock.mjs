import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign as rsaSign} from 'node:crypto';
import {MessageStore} from '../src/store.mjs';
import {Bridge} from '../src/bridge.mjs';
import {ownerVerifier} from '../src/auth.mjs';
import {handler} from '../src/http.mjs';
import {sign,equal} from '../src/security.mjs';

// In-process HTTP Request/Response + callback adapter; no listener, DNS, Weixin
// request or cloud subscription. Keys exist only for this synthetic demo.
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),resource='https://bridge.example.com/mcp',issuer='https://identity.example.com';
const jwk={...pair.publicKey.export({format:'jwk'}),kid:'demo-key',use:'sig',alg:'RS256'},now=Math.floor(Date.now()/1000);
const head=Buffer.from(JSON.stringify({alg:'RS256',typ:'at+jwt',kid:jwk.kid})).toString('base64url'),claims=Buffer.from(JSON.stringify({iss:issuer,aud:resource,sub:'demo-subject',scope:'weixin:owner',iat:now,exp:now+300})).toString('base64url');
const bearer=head+'.'+claims+'.'+rsaSign('RSA-SHA256',Buffer.from(head+'.'+claims),pair.privateKey).toString('base64url');
const auth=ownerVerifier({issuer,resource,subject:'demo-subject',canonicalOwner:'demo-owner',jwks:[jwk]}),secret='whsec_'+randomBytes(32).toString('base64');
let verified=0,events=0,providerCalls=0;
const adapter=new MessageStore({mode:'mock',ownerHash:auth.ownerHash,key:randomBytes(32),provider:async()=>{providerCalls++;throw new Error('unexpected_provider');}});
const bridge=new Bridge({adapter,auth,mode:'mock',callbackHosts:['callbacks.example.com'],callback:async(_url,headers,body)=>{
  const expected=await sign(secret,headers['webhook-id'],Number(headers['webhook-timestamp']),body);assert.ok(equal(expected,headers['webhook-signature']));verified++;
  const data=JSON.parse(body);if(data.eventId)events++;return {status:200,body:JSON.stringify(data.type==='verification'?{challenge:data.challenge}:{ok:true})};
}}),handle=handler(bridge);let id=0;
const rpc=async(method,params)=>{const response=await handle(new Request(resource,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})}));const data=await response.json();assert.equal(response.status,200);assert.equal(data.error,undefined);return data.result;};
try{
  bridge.start();await adapter.flush();assert.equal((await rpc('events/list',{})).events.length,1);
  await rpc('events/subscribe',{name:'weixin.message.created',arguments:{binding_id:'mock-binding'},delivery:{mode:'webhook',url:'https://callbacks.example.com/events',secret},ttlMs:60000});await adapter.flush();
  const injected=(await rpc('tools/call',{name:'mock_weixin_inbound',arguments:{binding_id:'mock-binding',message_id:'demo-01',nonce:'demo-01'}})).structuredContent;await adapter.flush();
  const args={binding_id:'mock-binding',message_id:injected.message_id};const read=(await rpc('tools/call',{name:'get_message',arguments:args})).structuredContent;assert.equal(read.text,'Synthetic message: demo-01');
  const final=(await rpc('tools/call',{name:'reply_weixin',arguments:{...args,text:'Synthetic final: demo-01'}})).structuredContent;
  const duplicate=(await rpc('tools/call',{name:'reply_weixin',arguments:{...args,text:'Synthetic final: demo-01'}})).structuredContent;
  assert.equal(final.sent,false);assert.equal(final.simulated,true);assert.equal(duplicate.duplicate,true);assert.equal(events,1);assert.equal(providerCalls,0);
  console.log(JSON.stringify({ok:true,mode:'mock',signature_checks:verified,events,final_claims:1,duplicate_suppressed:true,provider_calls:providerCalls,external_network_calls:0,cloud_subscription_verified:false}));
}catch{console.error('Synthetic demo failed.');process.exitCode=1;}finally{await bridge.close();}
