import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign as rsaSign} from 'node:crypto';
import {sha} from '../src/store.mjs';
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
const adapter=new MessageStore({mode:'mock',ownerHash:auth.ownerHash,key:randomBytes(32),features:{outboundImages:true,quoteCache:true,processing:true,typing:true,receiptTyping:true,notifications:true,acknowledgements:true},provider:async()=>{providerCalls++;throw new Error('unexpected_provider');}});
const bridge=new Bridge({adapter,auth,mode:'mock',callbackHosts:['callbacks.example.com'],callback:async(_url,headers,body)=>{
  const expected=await sign(secret,headers['webhook-id'],Number(headers['webhook-timestamp']),body);assert.ok(equal(expected,headers['webhook-signature']));verified++;
  const data=JSON.parse(body);if(data.eventId)events++;return {status:200,body:JSON.stringify(data.type==='verification'?{challenge:data.challenge}:{ok:true})};
}}),handle=handler(bridge);let id=0;
const rpc=async(method,params)=>{const response=await handle(new Request(resource,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})}));const data=await response.json();assert.equal(response.status,200);assert.equal(data.error,undefined);return data.result;};
try{
  bridge.start();await adapter.flush();assert.equal((await rpc('events/list',{})).events.length,1);
  await rpc('events/subscribe',{name:'weixin.message.created',arguments:{binding_id:'mock-binding'},delivery:{mode:'webhook',url:'https://callbacks.example.com/events',secret},ttlMs:60000});await adapter.flush();
  const call=async(name,args={})=>(await rpc('tools/call',{name,arguments:args}));
  const common={binding_id:'mock-binding'};
  const picture=(await call('mock_weixin_inbound',{...common,message_id:'demo-image',nonce:'demo-image',kind:'image'})).structuredContent;await adapter.flush();
  const quoted=(await call('mock_weixin_inbound',{...common,message_id:'demo-quote',nonce:'demo-quote',quote:'inline'})).structuredContent;await adapter.flush();
  const batch=await call('read_pending_weixin',{...common,limit:3});assert.equal(batch.structuredContent.messages.length,2);const imageRow=batch.structuredContent.messages.find(x=>x.message_id===picture.message_id),quoteRow=batch.structuredContent.messages.find(x=>x.message_id===quoted.message_id);assert.equal(quoteRow.inbound_quote.trust,'untrusted');assert.equal(quoteRow.inbound_quote.text,'Synthetic quoted text');const block=batch.content[imageRow.native_image_content_indexes[0]];assert.equal(block.type,'image');
  const work=(await call('processing_weixin',{...common,message_id:picture.message_id,phase:'running'})).structuredContent;assert.equal(work.processing_state.phase,'running');
  const ack=(await call('acknowledge_weixin',{...common,message_id:quoted.message_id,text:'Synthetic acknowledgement'})).structuredContent;assert.equal(ack.sent,false);
  const imageArgs={...common,message_id:picture.message_id,image:{mime_type:block.mimeType,data:block.data}},final=(await call('reply_weixin_image',imageArgs)).structuredContent;assert.equal(final.sent,false);assert.equal(final.simulated,true);assert.equal((await call('reply_weixin_image',imageArgs)).structuredContent.duplicate,true);
  const now=Date.now(),notification=(await call('notify_owner',{...common,notification_id:'notify_'+sha('demo-occurrence'),text:'Synthetic notification',created_ms:now,expires_ms:now+10000})).structuredContent;assert.equal(notification.send_state,'sent');assert.equal(notification.simulated,true);assert.equal(notification.sent,false);
  await call('reply_weixin',{...common,message_id:quoted.message_id,text:'Synthetic final'});assert.equal(adapter.db.prepare("SELECT count(*) n FROM ledger WHERE reply_state='sent'").get().n,2);assert.equal(providerCalls,0);
  console.log(JSON.stringify({ok:true,mode:'mock',signature_checks:verified,events,native_images:1,independent_batch_messages:2,untrusted_quote_read:true,processing_lease:true,explicit_ack_simulated:true,image_final_simulated:true,notification_simulated:true,final_claims:2,duplicate_suppressed:true,provider_calls:providerCalls,external_network_calls:0,cloud_subscription_verified:false,qr_enrollment_run:false}));

}catch{console.error('Synthetic demo failed.');process.exitCode=1;}finally{await bridge.close();}
