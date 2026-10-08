import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {initLocal} from '../scripts/init-local.mjs';
import {switchRelease} from '../scripts/switch-release.mjs';
import {privateFile,recoverLock} from '../src/private-files.mjs';
import {readConfig} from '../src/config.mjs';
import {MessageStore} from '../src/store.mjs';
import {serve} from '../src/server.mjs';
import {stateSchema} from '../src/state-schema.mjs';
import {jwk} from './fixture.mjs';
const project=fileURLToPath(new URL('..',import.meta.url));
function directory(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bridge-ops-')));fs.chmodSync(dir,0o700);return {dir,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};}
const availablePort=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;};
function setup(root,port){const dir=path.join(root,'private');initLocal(dir);const file=path.join(dir,'config.json'),c=JSON.parse(fs.readFileSync(file));c.listen.port=port;c.resource='http://127.0.0.1:'+port+'/mcp';fs.writeFileSync(file,JSON.stringify(c));return file;}
test('local initializer creates only private mock configuration and refuses overwriting it',t=>{
  const f=directory(t);t.after(f.cleanup);const dir=path.join(f.dir,'private'),r=initLocal(dir);assert.equal(r.provider_access_configured,false);assert.throws(()=>initLocal(dir));
  for(const name of ['config.json','secrets/local-token','secrets/state-key'])assert.equal(fs.statSync(path.join(dir,name)).mode&0o777,0o600);assert.equal(fs.statSync(path.join(dir,'state')).mode&0o777,0o700);
  const {config,auth,key}=readConfig(path.join(dir,'config.json'));assert.equal(config.mode,'mock');assert.equal(key.length,32);assert.throws(()=>auth.verify(new Request(config.resource)));key.fill(0);
});
test('private file reads reject symlink, hardlink, public mode and oversized input',t=>{
  const f=directory(t);t.after(f.cleanup);const file=path.join(f.dir,'secret');fs.writeFileSync(file,'fixture-only',{mode:0o600});assert.equal(privateFile(file),'fixture-only');
  const link=path.join(f.dir,'link');fs.symlinkSync(file,link);assert.throws(()=>privateFile(link));fs.unlinkSync(link);fs.linkSync(file,link);assert.throws(()=>privateFile(file));fs.unlinkSync(link);fs.chmodSync(file,0o644);assert.throws(()=>privateFile(file));fs.chmodSync(file,0o600);fs.writeFileSync(file,'x'.repeat(65537));assert.throws(()=>privateFile(file));
});
test('local bearer cannot enable real mode or a public resource',t=>{
  const f=directory(t);t.after(f.cleanup);const file=setup(f.dir,8787),original=JSON.parse(fs.readFileSync(file));
  for(const patch of [{mode:'real'},{resource:'https://bridge.example.com/mcp'},{listen:{host:'0.0.0.0',port:8787}}]){fs.writeFileSync(file,JSON.stringify({...original,...patch}));assert.throws(()=>readConfig(file));}
});
test('real HTTP listener starts mock, authenticates, and closes without retaining writer lock',async t=>{
  const f=directory(t),file=setup(f.dir,await availablePort());let app;t.after(async()=>{await app?.close();f.cleanup();});app=await serve(file);const {config,key}=readConfig(file);key.fill(0);
  assert.equal((await fetch(new URL('/healthz',config.resource))).status,200);const r=await fetch(config.resource,{method:'POST',headers:{'Content-Type':'application/json','x-owner':'untrusted'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})});assert.equal(r.status,401);
  assert.ok(fs.existsSync(config.state.database+'.lock'));await Promise.all([app.close(),app.close()]);assert.equal(fs.existsSync(config.state.database+'.lock'),false);
});
test('occupied listener fails before creating the database',async t=>{
  const f=directory(t),server=net.createServer();t.after(async()=>{if(server.listening)await new Promise(r=>server.close(r));f.cleanup();});await new Promise(r=>server.listen(0,'127.0.0.1',r));const file=setup(f.dir,server.address().port);await assert.rejects(serve(file),e=>e.code==='EADDRINUSE');assert.equal(fs.existsSync(path.join(f.dir,'private/state/mock.sqlite')),false);
});
test('release switch preserves the ledger and key, refuses a live lock and accepts symlink CLI startup',async t=>{
  const f=directory(t),file=setup(f.dir,await availablePort()),{config,auth,key}=readConfig(file);let app;
  t.after(async()=>{await app?.close();f.cleanup();});const a=new MessageStore({key,ownerHash:auth.ownerHash,dbPath:config.state.database});key.fill(0);a.db.prepare("INSERT INTO ledger(id,input_digest,created,reply_state) VALUES(?,?,?,'uncertain')").run('fixture-claim','fixture-digest',1700000000000);
  for(const name of ['v1','v2']){const dir=path.join(f.dir,'releases',name);fs.mkdirSync(path.dirname(dir),{recursive:true});fs.cpSync(project,dir,{recursive:true});}
  assert.throws(()=>switchRelease({root:f.dir,release:'v1',configFile:file}),/stop_writer_first/);await a.close();const before=fs.readFileSync(config.state.database),stateKey=fs.readFileSync(config.state.keyFile);
  for(const release of ['v1','v2','v1']){assert.equal(switchRelease({root:f.dir,release,configFile:file}).database_restored,false);assert.deepEqual(fs.readFileSync(config.state.database),before);assert.deepEqual(fs.readFileSync(config.state.keyFile),stateKey);}
  assert.throws(()=>switchRelease({root:f.dir,release:'../private',configFile:file}));
  const child=spawn(process.execPath,[path.join(f.dir,'current/src/server.mjs'),'--config',file],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});let output='';
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('startup_timeout')),5000);child.once('exit',()=>{clearTimeout(timer);reject(new Error('early_exit'));});child.stdout.on('data',b=>{output+=b;if(output.includes('"ready":true')){clearTimeout(timer);resolve();}});});
  const exited=new Promise(r=>child.once('exit',r));child.kill('SIGINT');child.kill('SIGINT');await exited;assert.equal(fs.existsSync(config.state.database+'.lock'),false);
});
test('release switch rejects token, JWKS and binding inside releases, including an ancestor symlink',t=>{
  const f=directory(t);t.after(f.cleanup);const file=setup(f.dir,8787),original=JSON.parse(fs.readFileSync(file)),release=path.join(f.dir,'releases/v1');fs.mkdirSync(path.join(release,'src'),{recursive:true});fs.writeFileSync(path.join(release,'src/server.mjs'),'// fixture release');fs.writeFileSync(path.join(release,'package.json'),'{}');
  const jwtAuth={mode:'jwt',issuer:'https://identity.example.com',subject:'fixture-subject',jwksFile:path.join(f.dir,'private/jwks.json')};fs.writeFileSync(jwtAuth.jwksFile,JSON.stringify({keys:[jwk]}),{mode:0o600});
  const token=path.join(release,'token'),jwks=path.join(release,'jwks.json'),binding=path.join(release,'binding.json');fs.writeFileSync(token,randomBytes(32).toString('base64url'),{mode:0o600});fs.writeFileSync(jwks,JSON.stringify({keys:[jwk]}),{mode:0o600});fs.writeFileSync(binding,JSON.stringify({botToken:randomBytes(32).toString('base64url'),botId:'fixture-bot',ownerPeerId:'fixture-peer',apiBase:'https://ilinkai.weixin.qq.com',boundAtMs:1700000000000,consent:{persist:true,receive:true,send:false}}),{mode:0o600});
  const alias=path.join(f.dir,'outside-alias');fs.symlinkSync(release,alias,'dir');
  for(const patch of [{auth:{mode:'local-bearer',tokenFile:token}},{auth:{mode:'local-bearer',tokenFile:path.join(alias,'token')}},{resource:'https://bridge.example.com/mcp',auth:{...jwtAuth,jwksFile:jwks}},{mode:'real',resource:'https://bridge.example.com/mcp',auth:jwtAuth,real:{enable:true,bindingFile:binding}}]){
    fs.writeFileSync(file,JSON.stringify({...original,...patch}));assert.throws(()=>switchRelease({root:f.dir,release:'v1',configFile:file}),/state_must_live_outside_releases/);assert.equal(fs.existsSync(path.join(f.dir,'current')),false);
  }
});
test('stale lock recovery refuses a running PID; explicit recovery never changes SQLite bytes',t=>{
  const f=directory(t);t.after(f.cleanup);const database=path.join(f.dir,'state.sqlite');fs.writeFileSync(database,'fixture database bytes',{mode:0o600});const lock=database+'.lock';
  fs.writeFileSync(lock,JSON.stringify({profile:'weixin-mcp-writer-v1',pid:process.pid}),{mode:0o600});assert.throws(()=>recoverLock(database,{confirmStopped:true}),/writer_may_be_running/);assert.throws(()=>recoverLock(database),/confirm_stopped_required/);
  const child=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});const pid=Number(child.stdout);assert.ok(pid>0);fs.writeFileSync(lock,JSON.stringify({profile:'weixin-mcp-writer-v1',pid}));assert.equal(recoverLock(database,{confirmStopped:true}).removed_stale_lock,true);assert.equal(fs.readFileSync(database,'utf8'),'fixture database bytes');
});
test('local revocation CLI retains terminal claims and blocks restart without any provider access',async t=>{
  const f=directory(t),file=setup(f.dir,await availablePort());t.after(f.cleanup);const app=await serve(file);await app.close();const {config,auth,key}=readConfig(file),a=new MessageStore({key,ownerHash:auth.ownerHash,dbPath:config.state.database});key.fill(0);a.db.prepare("INSERT INTO ledger(id,input_digest,created,reply_state) VALUES(?,?,?,'uncertain')").run('fixture-claim','fixture-digest',1700000000000);await a.close();
  const result=spawnSync(process.execPath,[path.join(project,'scripts/revoke.mjs'),'--config',file,'--confirm-revoke'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).network_calls,0);await assert.rejects(serve(file),/not_authorized/);assert.equal(fs.existsSync(config.state.database+'.lock'),false);
});
test('extended startup and release switching reject legacy or unknown state profiles before mutation',async t=>{
 const f=directory(t),file=setup(f.dir,await availablePort()),{config,auth,key}=readConfig(file);t.after(f.cleanup);const a=new MessageStore({key,ownerHash:auth.ownerHash,dbPath:config.state.database}),identity=a.unseal(a.db.prepare("SELECT value FROM bridge_meta WHERE name='identity'").get().value,'identity');
 a.db.prepare("INSERT INTO ledger(id,input_digest,created,reply_state) VALUES(?,?,?,'uncertain')").run('fixture-claim','fixture-digest',1700000000000);await a.close();assert.equal(stateSchema(config.state.database,key),2);
 for(const version of ['new','old']){const dir=path.join(f.dir,'releases',version);fs.mkdirSync(path.join(dir,'src'),{recursive:true});fs.writeFileSync(path.join(dir,'src/server.mjs'),'// fixture release');fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'weixin-mcp-bridge',version:version==='old'?'0.1.0':'0.2.0',...(version==='new'?{bridgeStateSchema:2}:{})}));}
 const before=fs.readFileSync(config.state.database);assert.throws(()=>switchRelease({root:f.dir,release:'old',configFile:file}),/state_schema_incompatible/);assert.deepEqual(fs.readFileSync(config.state.database),before);assert.equal(switchRelease({root:f.dir,release:'new',configFile:file}).database_restored,false);
 const edit=new MessageStore({key,ownerHash:auth.ownerHash,dbPath:config.state.database});edit.db.prepare("UPDATE bridge_meta SET value=? WHERE name='identity'").run(edit.seal({...identity,profile:'weixin-mcp-text-v1'},'identity'));await edit.close();assert.equal(stateSchema(config.state.database,key),1);const legacy=fs.readFileSync(config.state.database);await assert.rejects(serve(file),/state_identity_or_schema_invalid/);assert.throws(()=>switchRelease({root:f.dir,release:'new',configFile:file}),/state_schema_incompatible/);assert.deepEqual(fs.readFileSync(config.state.database),legacy);assert.equal(fs.existsSync(config.state.database+'.lock'),false);key.fill(0);
});
