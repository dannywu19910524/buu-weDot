import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {fixture,jwt,resource,epoch} from './fixture.mjs';
import {Bridge} from '../src/bridge.mjs';
const params=(secret,binding='mock-binding',url='https://callbacks.example.com/event')=>({name:'weixin.message.created',arguments:{binding_id:binding},delivery:{mode:'webhook',url,secret},ttlMs:3600000});
const unsubscribe=()=>({name:'weixin.message.created',arguments:{binding_id:'mock-binding'},delivery:{mode:'webhook',url:'https://callbacks.example.com/event'}});
test('adapter/bridge mode mismatches reject both directions before exposing mock tools',async t=>{
  for(const mode of ['mock','real']){const f=fixture({mode});t.after(f.close);assert.throws(()=>new Bridge({adapter:f.a,auth:f.auth,mode:mode==='mock'?'real':'mock'}),/configuration_required/);}
});
test('MCP discovery and schemas expose only the configured binding and supported tools',async t=>{
  for(const mode of ['mock','real']){const f=fixture({mode});t.after(f.close);
    const init=await(await f.rpc('initialize',{protocolVersion:'2025-11-25'})).json();assert.deepEqual(init.result.capabilities,{tools:{},events:{}});
    const list=await(await f.rpc('events/list',{})).json();assert.deepEqual(list.result.events[0].inputSchema.properties.binding_id.enum,[f.b.binding]);
    const tools=await(await f.rpc('tools/list',{})).json();assert.equal(tools.result.tools.some(x=>x.name==='mock_weixin_inbound'),mode==='mock');
  }
});
test('signed verification, max TTL, secret rotation and same destination are enforced',async t=>{
  const f=fixture();t.after(f.close);await f.start();const first=await f.subscribe(undefined,{ttlMs:999999999});assert.equal(Date.parse(first.refreshBefore),f.now()+3600000);
  const old=f.key(),next='whsec_'+randomBytes(32).toString('base64');const renewed=await f.subscribe(next);assert.equal(renewed.id,first.id);assert.equal(f.b.subscription().oldSecret,old);assert.equal(f.b.subscription().rotateUntil,f.now()+300000);
  await assert.rejects(f.b.subscribe(params(next,'mock-binding','https://callbacks.example.com/another')),/binding_already_subscribed/);
  await assert.rejects(f.b.subscribe({...params(next),cursor:'replay'}),/replay_not_supported/);
});
test('verification challenge failure cannot create a subscription',async t=>{
  const f=fixture({callback:async()=>({status:200,body:'{"challenge":"wrong"}'})});t.after(f.close);await f.start();await assert.rejects(f.subscribe(),/challenge_failed/);assert.equal(f.b.subscription(),null);
});
test('private addresses, redirects-as-destinations and foreign callback hosts fail before callback',async t=>{
  const f=fixture();t.after(f.close);await f.start();
  for(const url of ['http://127.0.0.1/','https://127.0.0.1/','https://REPLACE_WITH_USERNAME:REPLACE_WITH_PASSWORD@callbacks.example.com/','https://foreign.example.com/','https://callbacks.example.com:8443/','https://callbacks.example.com/path#fragment'])await assert.rejects(f.b.subscribe(params(f.key(),'mock-binding',url)));
  assert.equal(f.callbacks.length,0);
});
for(const action of ['unsubscribe','expiry','revoke','pause'])test('late callback 2xx is fenced after '+action,async t=>{
  let release,started;const entered=new Promise(r=>started=r),f=fixture({callback:async(_u,_h,body,options)=>{const event=JSON.parse(body);if(event.type==='verification')return {status:200,body:JSON.stringify({challenge:event.challenge})};started(options.signal);return new Promise(r=>release=r);}});t.after(f.close);
  await f.start();await f.subscribe();const call=f.call('mock_weixin_inbound',{binding_id:'mock-binding',message_id:'late-01',nonce:'late-01'});const signal=await entered;await call;
  if(action==='unsubscribe')f.b.unsubscribe(unsubscribe());if(action==='expiry'){f.advance(3600001);f.b.subscription();}if(action==='revoke')f.a.revoke();if(action==='pause'){f.b.invalidate();f.a.stop();}
  assert.equal(signal.aborted,true);release({status:200,body:'{}'});await f.a.flushJob;assert.notEqual(f.a.db.prepare('SELECT ingested FROM messages').get()?.ingested,1);
});
test('first verification is cancellable and cannot resurrect after unsubscribe',async t=>{
  let release,started,challenge;const entered=new Promise(r=>started=r),f=fixture({callback:async(_u,_h,body,options)=>{challenge=JSON.parse(body).challenge;started(options.signal);return new Promise(r=>release=r);}});t.after(f.close);await f.start();const pending=f.subscribe(),signal=await entered;f.b.unsubscribe(unsubscribe());assert.equal(signal.aborted,true);release({status:200,body:JSON.stringify({challenge})});await assert.rejects(pending);assert.equal(f.b.subscription(),null);
});
test('bounded callback retry reuses event ID and honors durable exponential deadline',async t=>{
  const f=fixture({callback:async(_u,_h,body)=>{const p=JSON.parse(body);return p.type==='verification'?{status:200,body:JSON.stringify({challenge:p.challenge})}:{status:503,body:'untrusted provider detail'};}});t.after(f.close);await f.start();await f.subscribe();const id=(await f.inject()).event_id;
  await f.a.flush();assert.equal(f.callbacks.filter(x=>x.body.eventId).length,1);f.advance(1000);await f.a.flush();f.advance(2000);await f.a.flush();f.advance(60000);await f.a.flush();const events=f.callbacks.filter(x=>x.body.eventId);assert.equal(events.length,3);assert.ok(events.every(x=>x.body.eventId===id));
});
for(const status of [401,403,410])test('terminal callback '+status+' remains suppressed after subscription renewal',async t=>{
  const f=fixture({callback:async(_u,_h,body)=>{const p=JSON.parse(body);return p.type==='verification'?{status:200,body:JSON.stringify({challenge:p.challenge})}:{status};}});t.after(f.close);await f.start();await f.subscribe();await f.inject();assert.equal(f.b.subscription(),null);assert.equal(f.a.db.prepare('SELECT attempts FROM messages').get().attempts,3);f.advance(5000);await f.subscribe();await f.a.flush();assert.equal(f.callbacks.filter(x=>x.body.eventId).length,1);
});
test('JWT rejects wrong issuer, audience, subject, lifetime, scope and untrusted identity headers',async t=>{
  const f=fixture();t.after(f.close);for(const claims of [{iss:'https://foreign.example.com'},{aud:'https://foreign.example.com/mcp'},{sub:'another'},{scope:'unrelated'},{exp:epoch/1000},{exp:epoch/1000+601},{iat:epoch/1000+31},{nbf:epoch/1000+1}])assert.equal((await f.rpc('ping',{}, {Authorization:'Bearer '+jwt({claims})})).status,401);
  assert.equal((await f.rpc('ping',{}, {Authorization:'','oai-authenticated-user-id':'fixture-owner','x-owner':'fixture-owner'})).status,401);
  assert.equal((await f.rpc('ping',{}, {Origin:'https://foreign.example.com'})).status,403);assert.equal((await f.rpc('ping',{}, {Cookie:'session=untrusted'})).status,403);
});
test('JWT that expires while request body waits cannot begin a real send',async t=>{
  const f=fixture({mode:'real'});t.after(f.close);await f.start();await f.subscribe();await f.receive([f.wire()]);const id=f.a.db.prepare('SELECT id FROM messages').get().id,before=f.providerCalls.length;
  let controller;const body=new ReadableStream({start(c){controller=c;}}),request=new Request(resource,{method:'POST',duplex:'half',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt({claims:{exp:epoch/1000+1}})},body});
  const response=f.handle(request);f.advance(1500);controller.enqueue(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'reply_weixin',arguments:{binding_id:'real-binding',message_id:id,text:'must not send'}}})));controller.close();
  assert.equal((await response).status,403);assert.equal(f.providerCalls.length,before);assert.equal(f.a.db.prepare('SELECT reply_state FROM messages').get().reply_state,'ready');
});
test('JWT expiry after authorized send starts suppresses response but does not erase the single claim',async t=>{
  let release,started;const entered=new Promise(r=>started=r),f=fixture({mode:'real',send:()=>{started();return new Promise(r=>release=r);}});t.after(f.close);await f.start();await f.subscribe();await f.receive([f.wire()]);const id=f.a.db.prepare('SELECT id FROM messages').get().id;
  const pending=f.rpc('tools/call',{name:'reply_weixin',arguments:{binding_id:'real-binding',message_id:id,text:'final'}},{Authorization:'Bearer '+jwt({claims:{exp:epoch/1000+1}})});await entered;f.advance(1500);release({ret:0});assert.equal((await pending).status,403);assert.equal(f.a.db.prepare('SELECT reply_state FROM messages').get().reply_state,'sent');assert.equal(f.providerCalls.filter(x=>x.url.endsWith('/sendmessage')).length,1);
});
test('subscription lifetime is owner policy plus its own TTL, separate from one HTTP access token',async t=>{
  const f=fixture();t.after(f.close);await f.start();await f.subscribe();f.advance(301000);assert.ok(f.b.subscription());const r=await f.inject();assert.equal(f.callbacks.at(-1).body.eventId,r.event_id);f.a.revoke();assert.throws(()=>f.b.require(),/not_authorized/);
});
test('errors never reflect raw callback details or signing/provider secrets',async t=>{
  const detail=randomBytes(48).toString('base64url'),f=fixture({callback:async()=>{throw new Error(detail);}});t.after(f.close);await f.start();const r=await(await f.rpc('events/subscribe',params(f.key()))).text();assert.ok(!r.includes(detail));assert.ok(!r.includes(f.key()));assert.ok(!r.includes(f.binding.botToken));
});
test('library close also drains a cancelled first verification before closing SQLite',async t=>{
  let release,started,challenge;const entered=new Promise(r=>started=r),f=fixture({callback:async(_u,_h,body,options)=>{challenge=JSON.parse(body).challenge;started(options.signal);return new Promise(r=>release=r);}});t.after(f.close);await f.start();const subscribing=f.subscribe(),signal=await entered;
  let closed=false;const closing=f.close().then(()=>closed=true);await Promise.resolve();assert.equal(signal.aborted,true);assert.equal(closed,false);release({status:200,body:JSON.stringify({challenge})});await assert.rejects(subscribing);await closing;assert.equal(f.a.closed,true);
});
