import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import {Enrollment} from '../src/enrollment.mjs';
import {enrollLocal,enrollmentArguments,readVerificationCode} from '../scripts/enroll-weixin.mjs';
const consent={persist:true,receive:true,send:false};
function scenario(answer){let now=1700000000000,calls=[];const token=randomBytes(32).toString('base64url'),provider=async(url,options)=>{calls.push({url,options});if(url.includes('/get_bot_qrcode'))return {qrcode:randomBytes(24).toString('hex'),qrcode_img_content:'https://qr.example.com/REPLACE_WITH_QR_CONTENT'};return answer?answer():{status:'confirmed',bot_token:token,ilink_bot_id:'fixture-bot',ilink_user_id:'fixture-peer',baseurl:'https://ilinkai.weixin.qq.com'};};return {session:new Enrollment({enable:true,provider,clock:()=>now}),calls,token,advance:n=>now+=n};}
test('constructing enrollment is offline and start requires explicit enable and exact consent',async()=>{
 let calls=0;const e=new Enrollment({provider:()=>calls++});await assert.rejects(e.start(consent));assert.equal(calls,0);const f=scenario();await assert.rejects(f.session.start({...consent,owner:'other'}));assert.equal(f.calls.length,0);
});
test('enrollment binds one confirmed session to exact owner and never sends bot bearer in login calls',async()=>{
 const f=scenario(),s=await f.session.start(consent);assert.equal(f.calls.length,1);assert.equal(f.session.qrContent(s.session_id),'https://qr.example.com/REPLACE_WITH_QR_CONTENT');const r=await f.session.poll(s.session_id);assert.equal(r.state,'confirmed');assert.ok(!JSON.stringify(r).includes(f.token));assert.throws(()=>f.session.confirm(s.session_id,{ownerPeerId:'other',botId:r.bot_id,confirmOwner:true}));const binding=f.session.confirm(s.session_id,{ownerPeerId:r.owner_peer_id,botId:r.bot_id,confirmOwner:true});assert.equal(binding.botToken,f.token);assert.equal(binding.consent.send,false);assert.equal(f.calls.every(c=>!c.options.headers.Authorization),true);assert.throws(()=>f.session.confirm(s.session_id,{ownerPeerId:r.owner_peer_id,botId:r.bot_id,confirmOwner:true}));
});
for(const state of ['scaned_but_redirect','binded_redirect'])test('enrollment rejects unsupported provider redirect '+state,async()=>{
 const f=scenario(()=>({status:state,redirect_host:'foreign.example.com'})),s=await f.session.start(consent);await assert.rejects(f.session.poll(s.session_id));assert.equal(f.calls.length,2);assert.ok(f.calls.every(x=>new URL(x.url).hostname==='ilinkai.weixin.qq.com'));
});
test('expired or cancelled late confirmation cannot yield credentials',async()=>{
 let done;const f=scenario(()=>new Promise(r=>done=r)),s=await f.session.start(consent),p=f.session.poll(s.session_id);f.session.cancel();done({status:'confirmed',bot_token:f.token,ilink_bot_id:'fixture-bot',ilink_user_id:'fixture-peer'});await assert.rejects(p);assert.equal(f.session.status().state,'expired');const g=scenario(),q=await g.session.start(consent);g.advance(300000);await assert.rejects(g.session.poll(q.session_id));assert.equal(g.calls.length,1);
});
test('verification code is accepted only in that same session requested phase',async()=>{
 let round=0;const f=scenario(()=>++round===1?{status:'need_verifycode'}:{status:'confirmed',bot_token:randomBytes(32).toString('base64url'),ilink_bot_id:'fixture-bot',ilink_user_id:'fixture-peer'}),s=await f.session.start(consent);await assert.rejects(f.session.poll(s.session_id,'123456'));assert.equal((await f.session.poll(s.session_id)).state,'need_verifycode');assert.equal((await f.session.poll(s.session_id,'123456')).state,'confirmed');assert.match(f.calls.at(-1).url,/verify_code=123456/);
});
test('local CLI saves only private binding after two explicit confirmations and emits no secrets',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-enroll-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const f=scenario(),out=[],answers=['RECEIVE','','CONFIRM OWNER'],target=path.join(dir,'binding');await enrollLocal({directory:target,run:true,input:{isTTY:true},output:{isTTY:true,write:v=>out.push(v)},enrollment:f.session,ask:async()=>answers.shift()});assert.deepEqual(fs.readdirSync(target),['binding.json']);assert.equal(fs.statSync(target).mode&0o777,0o700);assert.equal(fs.statSync(path.join(target,'binding.json')).mode&0o777,0o600);assert.equal(JSON.parse(fs.readFileSync(path.join(target,'binding.json'))).botToken,f.token);assert.ok(!out.join('').includes(f.token)&&!out.join('').includes('fixture-peer')&&!out.join('').includes('qr.example.com'));assert.ok(f.calls.every(x=>!x.url.includes('/getupdates')&&!x.url.includes('/sendmessage')));
});
test('CLI rejects noninteractive/default launch, malformed arguments and writable parent before start',async t=>{
 assert.throws(()=>enrollmentArguments(['--run']));assert.throws(()=>enrollmentArguments(['--directory','--run']));assert.throws(()=>enrollmentArguments(['--directory','one','--directory','two','--run']));assert.throws(()=>enrollmentArguments(['--directory','one','extra','--run']));const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-enroll-')));fs.chmodSync(dir,0o777);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const f=scenario();await assert.rejects(enrollLocal({directory:path.join(dir,'unsafe'),run:true,input:{isTTY:true},output:{isTTY:true},enrollment:f.session}));assert.equal(f.calls.length,0);await assert.rejects(enrollLocal({directory:path.join(dir,'unsafe')}));
});
test('hidden verification input never echoes digits and restores raw mode',async()=>{
 const input=new EventEmitter();input.isTTY=true;input.isRaw=false;input.resume=()=>{};input.setRawMode=value=>input.isRaw=value;let output='';const p=readVerificationCode(input,{write:s=>output+=s},1000);input.emit('data',Buffer.from('123456\r'));assert.equal(await p,'123456');assert.equal(input.isRaw,false);assert.ok(!output.includes('123456'));assert.equal(input.listenerCount('data'),0);
});
