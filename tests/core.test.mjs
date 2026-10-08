import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fixture,epoch,ownerHash,liveFixtures} from './fixture.mjs';
import {MessageStore} from '../src/store.mjs';
function temp(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-test-')));fs.chmodSync(dir,0o700);const dbPath=path.join(dir,'state.sqlite');t.after(async()=>{for(const f of [...liveFixtures])if(f.dbPath===dbPath)await f.close();fs.rmSync(dir,{recursive:true,force:true});});return dbPath;}
const row=f=>f.a.db.prepare('SELECT * FROM messages').get();
test('mock full signed event, independent read, one final and no provider calls',async t=>{
  const f=fixture();t.after(f.close);await f.start();await f.subscribe();const injected=await f.inject(),args={binding_id:'mock-binding',message_id:injected.message_id};
  assert.equal(injected.source_created_ms,f.now());assert.equal(f.callbacks[1].body.eventId,injected.event_id);
  const read=(await f.call('get_message',args)).result.structuredContent;assert.equal(read.text,'Synthetic message: fixture-01');assert.equal(read.replyable,true);assert.equal(read.reply_acknowledged_at_ms,null);
  const results=await Promise.all(Array.from({length:6},()=>f.call('reply_weixin',{...args,text:'Synthetic final'})));assert.equal(results.filter(r=>r.result.structuredContent.duplicate===false).length,1);assert.ok(results.every(r=>r.result.structuredContent.sent===false));
  assert.ok((await f.call('reply_weixin',{...args,text:'Different'})).error);assert.equal((await f.call('list_pending_weixin',{binding_id:'mock-binding'})).result.structuredContent.messages.length,0);assert.equal((await f.call('bridge_status')).result.structuredContent.pending_messages.length,0);assert.equal(f.providerCalls.length,0);
});
test('binding separation, owner policy and fixed synthetic input reject invalid access',async t=>{
  const f=fixture();t.after(f.close);await f.start();await f.subscribe();const r=await f.inject();
  for(const [name,args] of [['get_message',{binding_id:'real-binding',message_id:r.message_id}],['mock_weixin_inbound',{binding_id:'mock-binding',message_id:'x',nonce:'bad space'}],['reply_weixin',{binding_id:'mock-binding',message_id:r.message_id,text:'x',recipient:'other'}],['unknown_tool',{}]])assert.ok((await f.call(name,args)).error);
  assert.throws(()=>f.a.require('0'.repeat(64)));f.a.revoke();assert.ok((await f.call('get_message',{binding_id:'mock-binding',message_id:r.message_id})).error);assert.equal(f.providerCalls.length,0);
});
test('persistent seed and final survive restart; expired body never becomes a new event',async t=>{
  const dbPath=temp(t),key=randomBytes(32),a=fixture({dbPath,key});await a.start();await a.subscribe();const r=await a.inject();await a.call('reply_weixin',{binding_id:'mock-binding',message_id:r.message_id,text:'final'});await a.close();
  const b=fixture({dbPath,key});t.after(b.close);await b.start();assert.equal(b.callbacks.length,0);const again=await b.inject();assert.equal(again.message_id,r.message_id);assert.equal(again.duplicate,true);assert.equal(b.callbacks.length,0);
  assert.equal((await b.call('reply_weixin',{binding_id:'mock-binding',message_id:r.message_id,text:'final'})).result.structuredContent.duplicate,true);
  b.advance(3600001);await b.subscribe();await b.inject('new','new');const expired=await b.inject();assert.equal(expired.source_created_ms,r.source_created_ms);assert.equal(expired.duplicate,true);assert.ok((await b.call('get_message',{binding_id:'mock-binding',message_id:r.message_id})).error);
});
test('mock seed conflicts and transaction failures do not create extra claim or event',async t=>{
  const f=fixture();t.after(f.close);await f.start();await f.subscribe();const r=await f.inject();await assert.rejects(f.inject('fixture-01','changed'));
  f.a.db.exec("CREATE TRIGGER fail_final BEFORE UPDATE OF reply_state ON ledger BEGIN SELECT RAISE(ABORT,'fixture_failure'); END;");
  assert.ok((await f.call('reply_weixin',{binding_id:'mock-binding',message_id:r.message_id,text:'final'})).error);assert.equal(row(f).reply_state,'ready');assert.equal(f.a.db.prepare('SELECT reply_state FROM ledger').get().reply_state,'ready');
});
test('real uint64 string IDs, filtering, owner text read and provider final acknowledgement',async t=>{
  const f=fixture({mode:'real'});t.after(f.close);await f.start();await f.subscribe();const valid=f.wire('18446744073709551615');
  await f.receive([valid,f.wire('2',{from_user_id:'foreign'}),f.wire('3',{group_id:'group'}),f.wire('4',{message_state:1}),f.wire('5',{create_time_ms:epoch-3600000}),f.wire('6',{item_list:[{type:2}]}),f.wire('7',{item_list:[{type:1,text_item:{text:'a'}},{type:1,text_item:{text:'b'}}]})]);
  assert.equal(f.a.db.prepare('SELECT count(*) n FROM messages').get().n,1);const id=row(f).id;assert.equal(f.a.unseal(row(f).value,'message:'+id).wireId,'18446744073709551615');await f.receive([valid]);assert.equal(f.callbacks.filter(x=>x.body.eventId).length,1);
  const r=await f.call('reply_weixin',{binding_id:'real-binding',message_id:id,text:'one final'});assert.equal(r.result.structuredContent.sent,true);assert.equal(f.providerCalls.filter(x=>x.url.endsWith('/sendmessage')).length,1);
  assert.equal((await f.call('reply_weixin',{binding_id:'real-binding',message_id:id,text:'one final'})).result.structuredContent.duplicate,true);
});
for(const response of [{},{ret:1},{errcode:1},null])test('uncertain provider outcome is a durable terminal send claim: '+JSON.stringify(response),async t=>{
  const dbPath=temp(t),key=randomBytes(32),f=fixture({mode:'real',dbPath,key,send:async()=>{if(response===null)throw new Error('private provider error');return response;}});await f.start();await f.subscribe();await f.receive([f.wire()]);const id=row(f).id;
  assert.equal((await f.call('reply_weixin',{binding_id:'real-binding',message_id:id,text:'final'})).error.data.reason,'send_result_uncertain');assert.equal(row(f).reply_state,'uncertain');const binding=f.binding;await f.close();
  const g=fixture({mode:'real',dbPath,key,binding});t.after(g.close);await g.start();assert.ok((await g.call('reply_weixin',{binding_id:'real-binding',message_id:id,text:'final'})).error);assert.equal(g.providerCalls.length,0);
});
test('startup sending-state recovery never resends; a second writer is rejected before recovery',async t=>{
  const dbPath=temp(t),key=randomBytes(32),f=fixture({mode:'real',dbPath,key});await f.start();await f.subscribe();await f.receive([f.wire()]);const id=row(f).id;
  f.a.db.exec("UPDATE messages SET reply_state='sending';UPDATE ledger SET reply_state='sending'");
  assert.throws(()=>fixture({mode:'real',dbPath,key,binding:f.binding}),/writer_active_or_stale_lock/);assert.equal(row(f).reply_state,'sending');const binding=f.binding;await f.close();
  const g=fixture({mode:'real',dbPath,key,binding});t.after(g.close);assert.equal(row(g).reply_state,'uncertain');await g.start();assert.ok((await g.call('reply_weixin',{binding_id:'real-binding',message_id:id,text:'retry'})).error);assert.equal(g.providerCalls.length,0);
});
test('persisted identity rejects another owner, mode, provider binding or key',async t=>{
  const dbPath=temp(t),key=randomBytes(32),f=fixture({mode:'real',dbPath,key});const binding=f.binding;await f.close();
  for(const override of [{ownerHash:'a'.repeat(64)},{mode:'mock'},{key:randomBytes(32)},{binding:{...binding,ownerPeerId:'other'}}])assert.throws(()=>new MessageStore({mode:'real',enableReal:true,binding,dbPath,key,ownerHash,...override}),/state_identity_or_schema_invalid/);
});
test('late provider success after revoke is uncertain; close drains send before closing SQLite',async t=>{
  let resolve,started;const entered=new Promise(r=>started=r),f=fixture({mode:'real',send:()=>{started();return new Promise(r=>resolve=r);}});t.after(f.close);await f.start();await f.subscribe();await f.receive([f.wire()]);const id=row(f).id;
  const reply=f.call('reply_weixin',{binding_id:'real-binding',message_id:id,text:'final'});await entered;f.a.revoke();let closed=false;const close=f.close().then(()=>closed=true);await Promise.resolve();assert.equal(closed,false);resolve({ret:0});assert.ok((await reply).error);await close;assert.equal(closed,true);
});
test('explicit real enable, send consent and one-hour expiry are independently required',async t=>{
  assert.throws(()=>new MessageStore({mode:'real',key:randomBytes(32),ownerHash}),/real_mode_requires_explicit_enable/);
  const f=fixture({mode:'real'});t.after(f.close);f.binding.consent.send=false;await f.start();await f.subscribe();await f.receive([f.wire()]);const id=row(f).id;f.advance(3600000);assert.ok((await f.call('reply_weixin',{binding_id:'real-binding',message_id:id,text:'too late'})).error);
  const g=fixture({mode:'real',binding:{...f.binding,consent:{persist:true,receive:true,send:false}}});t.after(g.close);await g.start();await g.subscribe();await g.receive([g.wire()]);assert.equal((await g.call('reply_weixin',{binding_id:'real-binding',message_id:row(g).id,text:'blocked'})).error.data.reason,'send_not_authorized');
});
test('provider X-WECHAT-UIN is base64 of decimal uint32 ASCII, not random binary',async t=>{
  const f=fixture({mode:'real'});t.after(f.close);await f.receive([]);const value=Buffer.from(f.providerCalls[0].headers['X-WECHAT-UIN'],'base64').toString('utf8');
  assert.match(value,/^\d+$/);assert.ok(Number(value)>=0&&Number(value)<=2**32-1);assert.equal(String(Number(value)),value);
});
test('provider session pause persists through restart and blocks calls until its one-hour deadline',async t=>{
  const dbPath=temp(t),key=randomBytes(32),f=fixture({mode:'real',dbPath,key,provider:async()=>({ret:-14})});await assert.rejects(f.a.receiveOnce(),/provider_session_paused/);const binding=f.binding;await f.close();
  const g=fixture({mode:'real',dbPath,key,binding});t.after(g.close);await assert.rejects(g.start(),/provider_session_paused/);await assert.rejects(g.a.receiveOnce(),/not_authorized/);assert.equal(g.providerCalls.length,0);g.advance(3600001);await g.start();await g.receive([]);assert.equal(g.providerCalls.length,1);
});
