import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './fixture.mjs';
import {imageFixture} from '../src/media.mjs';

test('private FIFO input rejects promptly without waiting for a writer',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-fifo-')),file=path.join(dir,'input');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  assert.equal(spawnSync('mkfifo',['-m','600',file]).status,0);
  const source=new URL('../src/private-files.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    `import {privateFile} from ${JSON.stringify(source)};try{privateFile(process.argv[1]);process.exitCode=1;}catch(e){if(e.message!=='private_file_required')process.exitCode=2;}`,file],{timeout:2000});
  assert.equal(child.error,undefined,'special-file reads must not block');assert.equal(child.status,0);
});

for(const mediaType of ['application/jsonp','application/json-extra','text/plain'])test('HTTP rejects non-JSON media type '+mediaType,async t=>{
  const f=fixture();t.after(f.close);const r=await f.rpc('ping',{}, {'Content-Type':mediaType});
  assert.equal(r.status,415);assert.deepEqual(await r.json(),{error:'application_json_required'});
});
test('HTTP accepts case-insensitive JSON media type with parameters',async t=>{
  const f=fixture();t.after(f.close);const r=await f.rpc('ping',{}, {'Content-Type':'Application/JSON; charset=utf-8'});
  assert.equal(r.status,200);assert.deepEqual((await r.json()).result,{});
});

test('pending final cannot outlive the message window while awaiting ACK',async t=>{
  let release,entered;const started=new Promise(r=>entered=r),f=fixture({mode:'real',features:{acknowledgements:true},send:()=>{entered();return new Promise(r=>release=r);}});
  t.after(f.close);await f.start();await f.subscribe();await f.receive([f.wire()]);
  const id=f.a.db.prepare('SELECT id FROM messages').get().id,ack=f.a.acknowledge(f.auth.ownerHash,id,'Synthetic acknowledgement');
  await started;const final=f.a.reply(f.auth.ownerHash,id,'Synthetic final');f.advance(3600000);release({ret:0});
  await assert.rejects(ack,/send_result_uncertain/);await assert.rejects(final,/message_not_available/);
  assert.equal(f.providerCalls.filter(x=>x.url.endsWith('/sendmessage')).length,1);
  assert.equal(f.a.db.prepare('SELECT state FROM acknowledgements').get().state,'uncertain');
  assert.equal(f.a.db.prepare('SELECT reply_state FROM ledger').get().reply_state,'ready');
});

for(const tool of ['get_message','read_pending_weixin'])test('late image result is withheld after source-record replacement: '+tool,async t=>{
  let release,entered;const started=new Promise(r=>entered=r),f=fixture({mode:'real',imageDownload:()=>{entered();return new Promise(r=>release=r);}});
  t.after(f.close);await f.start();await f.subscribe();await f.receive([f.wire('1',{item_list:[{type:2,image_item:{media:{encrypt_query_param:'REPLACE_WITH_IMAGE_QUERY'}}}]})]);
  const row=f.a.db.prepare('SELECT id,value FROM messages').get(),m=f.a.unseal(row.value,'message:'+row.id);
  const pending=f.call(tool,{binding_id:'real-binding',...(tool==='get_message'?{message_id:row.id}:{limit:1})});
  await started;f.a.db.prepare('UPDATE messages SET value=? WHERE id=?').run(f.a.seal({...m,text:'Synthetic replacement'},'message:'+row.id),row.id);
  release(imageFixture());const result=await pending;assert.equal(result.error.data.reason,'message_not_available');assert.equal(result.result,undefined);
});
