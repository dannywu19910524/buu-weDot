import {DatabaseSync} from 'node:sqlite';
import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {BridgeError,text} from './security.mjs';
import {writerLock} from './private-files.mjs';
import {STATE_PROFILE} from './state-schema.mjs';
import {featureConfig} from './features.mjs';
import {imageMetadata,pinnedImage,pinnedUpload,decryptImage,imageFixture,IMAGE_PLACEHOLDER,outboundImage,uploadImage} from './media.mjs';
import {captureInboundQuote} from './quotes.mjs';
import {OwnerQuoteTextCache} from './quote-cache.mjs';
import {Processing} from './processing.mjs';
import {Notifications} from './notifications.mjs';
import {API_HOST,apiBase,messageID,pinnedJSON} from './weixin-transport.mjs';

export const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=reason=>new BridgeError(reason,-32001);
export const WINDOW_MS=3600000;
const clean=(v,max=512)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
export function validateBinding(value){
  if(!value||Array.isArray(value)||Object.keys(value).some(k=>!['botToken','botId','ownerPeerId','apiBase','boundAtMs','consent'].includes(k))||!clean(value.botToken,4096)||!clean(value.botId)||!clean(value.ownerPeerId)||!Number.isSafeInteger(value.boundAtMs)||value.boundAtMs<0||!value.consent||Object.keys(value.consent).sort().join(',')!=='persist,receive,send'||value.consent.persist!==true||value.consent.receive!==true||typeof value.consent.send!=='boolean')throw new Error('binding_configuration_required');
  if([value.botToken,value.botId,value.ownerPeerId].some(x=>/REPLACE|CHANGEME|YOUR_/i.test(x)))throw new Error('binding_configuration_required');
  return {token:value.botToken,bot:value.botId,peer:value.ownerPeerId,base:apiBase(value.apiBase,[API_HOST]),boundAt:value.boundAtMs,consent:{...value.consent}};
}
function privateDatabase(file){
  if(file===':memory:')return;
  if(!path.isAbsolute(file))throw new Error('private_storage_required');
  const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});const parent=fs.lstatSync(dir);
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid()||parent.mode&0o077||fs.realpathSync(dir)!==dir)throw new Error('private_storage_required');
  if(!fs.lstatSync(file,{throwIfNoEntry:false}))fs.closeSync(fs.openSync(file,'wx',0o600));
  for(const candidate of [file,file+'-journal',file+'-wal',file+'-shm']){const s=fs.lstatSync(candidate,{throwIfNoEntry:false});if(s&&(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.nlink!==1||s.mode&0o077))throw new Error('private_storage_required');}
}

// Text and bounded images, one fixed owner. Mock and real stores have different persistent
// identities; changing mode/binding cannot silently adopt an existing ledger.
export class MessageStore {
  #key; #account; #provider; #imageDownload; #imageUpload;
  constructor({mode='mock',enableReal=false,binding,dbPath=':memory:',key,ownerHash,clock=Date.now,provider=pinnedJSON,clientVersion='2.4.9',features={},imageDownload=pinnedImage,imageUpload=pinnedUpload,schedule=setTimeout,cancelSchedule=clearTimeout}){
    if(!['mock','real'].includes(mode)||!Buffer.isBuffer(key)||key.length!==32||!/^[a-f0-9]{64}$/.test(ownerHash)||!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clientVersion))throw new Error('configuration_required');
    if(mode==='real'&&enableReal!==true)throw new Error('real_mode_requires_explicit_enable');
    this.features=featureConfig(features);this.#imageDownload=mode==='real'?imageDownload:async()=>{throw fail('mock_has_no_provider');};this.#imageUpload=mode==='real'?imageUpload:async()=>{throw fail('mock_has_no_provider');};this.imageActive=0;this.ackJobs=new Map();
    this.#account=mode==='real'?validateBinding(binding):{token:null,bot:'synthetic-bot',peer:'synthetic-owner',base:null,boundAt:0,consent:{persist:true,receive:true,send:false}};
    // Even an accidentally supplied provider function is unreachable in mock.
    this.#provider=mode==='real'?provider:async()=>{throw fail('mock_has_no_provider');};
    privateDatabase(dbPath);this.#key=Buffer.from(key);this.mode=mode;this.ownerHash=ownerHash;this.clock=clock;this.clientVersion=clientVersion;this.schedule=schedule;this.cancelSchedule=cancelSchedule;
    this.enabled=true;this.stopped=false;this.closed=false;this.active=false;this.generation=0;this.abort=new AbortController();this.jobs=new Set();this.flushJob=null;this.pollJob=null;this.retryTimer=null;this.pollTimer=null;this.maxEmitAttempts=mode==='mock'?3:6;this.emitReady=()=>false;this.emit=async()=>({accepted:false});
    this.lock=writerLock(dbPath);try{this.db=new DatabaseSync(dbPath);}catch(e){this.lock.release();throw e;}
    const identity={profile:STATE_PROFILE,mode,ownerHash,scope:sha(JSON.stringify([this.#account.token,this.#account.bot,this.#account.peer,this.#account.base,this.#account.boundAt]))};
    try{
      const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if(tables.length&&!tables.some(r=>r.name==='bridge_meta'))throw 0;
      if(tables.length&&JSON.stringify(this.unseal(this.db.prepare("SELECT value FROM bridge_meta WHERE name='identity'").get()?.value,'identity'))!==JSON.stringify(identity))throw 0;
      this.db.exec(`PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS bridge_meta(name TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mcp_policy(slot INTEGER PRIMARY KEY CHECK(slot=1),enabled INTEGER NOT NULL);
        INSERT OR IGNORE INTO mcp_policy VALUES(1,1);
        CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,value TEXT NOT NULL,created INTEGER NOT NULL,ingested INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,reply_state TEXT NOT NULL DEFAULT 'ready',reply_digest TEXT,reply_receipt TEXT);
        CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,input_digest TEXT NOT NULL,created INTEGER NOT NULL,delivery_state TEXT NOT NULL DEFAULT 'pending',reply_state TEXT NOT NULL DEFAULT 'ready',reply_digest TEXT,reply_receipt TEXT);
        CREATE TABLE IF NOT EXISTS message_timings(id TEXT PRIMARY KEY,received_ms INTEGER,committed_ms INTEGER);
        CREATE TABLE IF NOT EXISTS acknowledgements(id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT);`);
      this.db.prepare("INSERT OR IGNORE INTO bridge_meta VALUES('identity',?)").run(this.seal(identity,'identity'));
      // Crash during a real send has an unknown outcome: never restore ready.
      this.db.exec("BEGIN IMMEDIATE;UPDATE messages SET reply_state='uncertain' WHERE reply_state='sending';UPDATE ledger SET reply_state='uncertain' WHERE reply_state='sending';UPDATE acknowledgements SET state='uncertain' WHERE state='sending';COMMIT;");
      this.quoteCache=new OwnerQuoteTextCache(this,{enabled:this.features.quoteCache,schedule,cancelSchedule});this.processing=new Processing(this);this.notifications=new Notifications(this);
      if(!this.features.quoteCache&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='quote_text_cache'").get())this.db.exec('DELETE FROM quote_text_cache');
    }catch{this.db.close();this.lock.release();this.#key.fill(0);throw new Error('state_identity_or_schema_invalid');}
  }
  digest(value){return createHmac('sha256',this.#key).update(value).digest('hex');}
  seal(value,aad){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.#key,iv);c.setAAD(Buffer.from(aad));return Buffer.concat([iv,c.update(JSON.stringify(value)),c.final(),c.getAuthTag()]).toString('base64');}
  unseal(value,aad){const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',this.#key,b.subarray(0,12));c.setAAD(Buffer.from(aad));c.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([c.update(b.subarray(12,-16)),c.final()]));}
  require(owner){if(this.closed||this.stopped||owner!==this.ownerHash||!this.db.prepare('SELECT enabled FROM mcp_policy WHERE slot=1').get()?.enabled||(this.#account.pauseUntil??0)>this.clock())throw fail('not_authorized');}
  account(){return structuredClone(this.#account);}
  meta(name){const r=this.db.prepare('SELECT value FROM bridge_meta WHERE name=?').get(name);return r?this.unseal(r.value,'meta:'+name):null;}
  saveMeta(name,value){this.db.prepare('INSERT INTO bridge_meta VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name,this.seal(value,'meta:'+name));}
  current(generation){try{this.require(this.ownerHash);return generation===this.generation&&!this.abort.signal.aborted;}catch{return false;}}
  cleanup(){this.db.prepare('DELETE FROM messages WHERE created<=?').run(this.clock()-WINDOW_MS);this.db.exec('DELETE FROM message_timings WHERE id NOT IN (SELECT id FROM messages)');}
  validateRow(id,delivered=true){
    this.require(this.ownerHash);if(typeof id!=='string'||!/^wx_[a-f0-9]{64}$/.test(id))throw fail('message_not_available');
    const r=this.db.prepare('SELECT * FROM messages WHERE id=? AND created>?').get(id,this.clock()-WINDOW_MS);if(!r||delivered&&!r.ingested)throw fail('message_not_available');
    const m=this.unseal(r.value,'message:'+id),a=this.#account;
    if(m.id!==id||m.created!==r.created||m.bot!==a.bot||m.peer!==a.peer||m.created<a.boundAt||m.created>this.clock()+30000||!['text','image'].includes(m.kind)||typeof m.text!=='string'||this.mode==='mock'&&(m.mockOnly!==true||m.text!==(m.kind==='image'?IMAGE_PLACEHOLDER:'Synthetic message: '+m.mockNonce))||this.mode==='real'&&(m.mockOnly||!clean(m.context)))throw fail('message_not_available');
    return {r,m};
  }
  insert(m,inputDigest,received){
    const old=this.db.prepare('SELECT * FROM ledger WHERE id=?').get(m.id);
    if(old){if(this.mode==='mock'&&old.input_digest!==inputDigest)throw fail('message_id_conflict');return {inserted:false,created:old.created};}
    if(this.db.prepare('SELECT COUNT(*) n FROM ledger').get().n>=100000)throw fail('dedupe_ledger_full');
    this.db.prepare('INSERT INTO ledger(id,input_digest,created) VALUES(?,?,?)').run(m.id,inputDigest,m.created);
    this.db.prepare('INSERT INTO messages(id,value,created) VALUES(?,?,?)').run(m.id,this.seal(m,'message:'+m.id),m.created);
    this.db.prepare('INSERT INTO message_timings(id,received_ms,committed_ms) VALUES(?,?,NULL)').run(m.id,received);return {inserted:true,created:m.created};
  }
  inject({message_id:seed,nonce,kind='text',quote}){
    this.require(this.ownerHash);if(this.mode!=='mock'||quote!==undefined&&quote!=='inline'||!['text','image'].includes(kind)||kind==='image'&&!this.features.inboundImages||typeof seed!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(seed)||typeof nonce!=='string'||!/^[A-Za-z0-9-]{1,80}$/.test(nonce))throw fail('synthetic_arguments_required');
    const now=this.clock(),id='wx_'+sha(JSON.stringify(['mock',this.ownerHash,seed]));if(!Number.isSafeInteger(now)||now<0)throw fail('clock_invalid');
    const m={id,created:now,bot:this.#account.bot,peer:this.#account.peer,kind,text:kind==='image'?IMAGE_PLACEHOLDER:'Synthetic message: '+nonce,mockNonce:nonce,mockOnly:true,inboundQuote:quote==='inline'?captureInboundQuote({ref_msg:{message_item:{type:1,text_item:{text:'Synthetic quoted text'}}}}):{status:'none',quote:null}};
    this.db.exec('BEGIN IMMEDIATE');let r;try{this.cleanup();r=this.insert(m,sha(JSON.stringify([kind,nonce,quote??null])),now);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    if(r.inserted)this.db.prepare('UPDATE message_timings SET committed_ms=? WHERE id=?').run(this.clock(),id);
    this.kickEmit();return {binding_id:'mock-binding',message_id:id,source_created_ms:r.created,timestamp:new Date(r.created).toISOString(),duplicate:!r.inserted,simulated:true,sent:false};
  }
  async api(endpoint,body,options={}){
    if(this.mode!=='real')throw fail('mock_has_no_provider');this.require(this.ownerHash);
    const parts=this.clientVersion.split('.').map(Number);return this.#provider(this.#account.base+endpoint,{method:'POST',hosts:[API_HOST],signal:options.signal??this.abort.signal,...(options.timeoutMs?{timeoutMs:options.timeoutMs}:{}),headers:{'Content-Type':'application/json','AuthorizationType':'ilink_bot_token',Authorization:'Bearer '+this.#account.token,'X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),'iLink-App-Id':'bot','iLink-App-ClientVersion':String((parts[0]<<16)|(parts[1]<<8)|parts[2])},body:JSON.stringify({...body,base_info:{channel_version:this.clientVersion,bot_agent:'WeixinMCPBridge/0.2.0'}})});
  }
  receiveOnce(){
    if(this.pollJob)return this.pollJob;this.pollJob=this.track(this.poll()).finally(()=>this.pollJob=null);return this.pollJob;
  }
  async poll(){
    this.require(this.ownerHash);if(this.mode!=='real')throw fail('mock_has_no_provider');const generation=this.generation;
    // Optional official receive lifecycle notice, not a chat message. One
    // attempt per runtime generation; failure never causes automatic replay.
    if(this.features.providerStartNotice&&this.notifiedGeneration!==generation){this.notifiedGeneration=generation;try{await this.api('/ilink/bot/msg/notifystart',{}, {timeoutMs:3000});}catch{}if(!this.current(generation))return {accepted:0};}
    const data=await this.api('/ilink/bot/getupdates',{get_updates_buf:this.meta('cursor')??''});if(!this.current(generation))return {accepted:0};
    if(data.ret===-14||data.errcode===-14){this.#account.pauseUntil=this.clock()+WINDOW_MS;this.saveMeta('provider_pause_until',this.#account.pauseUntil);throw fail('provider_session_paused');}
    if(data.ret!==undefined&&data.ret!==0||data.errcode!==undefined&&data.errcode!==0||!Array.isArray(data.msgs)||data.msgs.length>100||data.get_updates_buf!==undefined&&(typeof data.get_updates_buf!=='string'||data.get_updates_buf.length>65536))throw fail('updates_rejected');
    const received=this.clock(),ids=[];this.db.exec('BEGIN IMMEDIATE');try{
      this.cleanup();for(const wire of data.msgs){
        const id=messageID(wire.message_id),item=wire.item_list?.[0],a=this.#account;
        if(!id||wire.from_user_id!==a.peer||wire.to_user_id!==a.bot||wire.group_id||wire.message_type!==1||wire.message_state!==2||!Number.isSafeInteger(wire.create_time_ms)||wire.create_time_ms<a.boundAt||wire.create_time_ms<=received-WINDOW_MS||wire.create_time_ms>received+30000||!clean(wire.context_token)||!Array.isArray(wire.item_list)||wire.item_list.length!==1)continue;
        let kind,body,media;
        if(item?.type===1&&typeof item.text_item?.text==='string'&&item.text_item.text&&Buffer.byteLength(item.text_item.text)<=8192&&!item.text_item.text.includes('\0')){kind='text';body=item.text_item.text;}
        else if(this.features.inboundImages&&item?.type===2){try{media=imageMetadata(item);}catch{continue;}kind='image';body=IMAGE_PLACEHOLDER;}else continue;
        const m={id:'wx_'+sha(JSON.stringify(['real',this.ownerHash,a.bot,a.peer,id])),wireId:id,created:wire.create_time_ms,bot:a.bot,peer:a.peer,context:wire.context_token,kind,text:body,inboundQuote:captureInboundQuote(item),...(media?{image:media}:{})};
        if(this.insert(m,sha(id),received).inserted){ids.push(m.id);if(kind==='text')this.quoteCache.put(a,id,body,m.created,'inbound');}

      }
      if(data.get_updates_buf)this.saveMeta('cursor',data.get_updates_buf);this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    for(const id of ids)this.db.prepare('UPDATE message_timings SET committed_ms=? WHERE id=?').run(this.clock(),id);this.quoteCache.arm();for(const id of ids)this.processing.receipt(id);this.kickEmit();return {accepted:ids.length};
  }
  receipt(owner,id){this.require(owner);const {r}=this.validateRow(id),receipt=r.reply_receipt?JSON.parse(r.reply_receipt):null;return {send_state:r.reply_state,sent:this.mode==='mock'?false:r.reply_state==='sent'?true:r.reply_state==='ready'?false:null,reply_acknowledged_at_ms:this.mode==='real'&&r.reply_state==='sent'?receipt?.acknowledged_at_ms??null:null};}
  quote(m){return this.features.quoteReplies&&m.wireId&&m.wireId!=='0'?{ref_msg:{svr_id:m.wireId,...(m.kind==='text'?{message_item:{type:1,text_item:{text:m.text}}}:{})}}:{};}
  sendItems(m,items,clientId){this.require(this.ownerHash);const a=this.#account;if(this.mode!=='real'||!a.consent.send||m.bot!==a.bot||m.peer!==a.peer||!clean(m.context))throw fail('send_not_authorized');return this.api('/ilink/bot/sendmessage',{msg:{from_user_id:'',to_user_id:a.peer,client_id:clientId,message_type:2,message_state:2,context_token:m.context,item_list:items}});}
  readImage(owner,id){return this.track(this.image(owner,id));}
  async image(owner,id){
    this.require(owner);const {r,m}=this.validateRow(id);if(!this.features.inboundImages||m.kind!=='image'||this.imageActive>=2)throw fail('image_unavailable');const generation=this.generation,current=()=>{try{return this.current(generation)&&this.validateRow(id).r.value===r.value;}catch{return false;}};this.imageActive++;
    try{const bytes=this.mode==='mock'?imageFixture():await this.#imageDownload(m.image.url,{signal:this.abort.signal});if(!current())throw 0;const v=decryptImage(bytes,this.mode==='mock'?null:m.image.key);if(!current())throw 0;return v;}catch{throw fail('image_unavailable');}finally{this.imageActive--;}
  }
  reply(owner,id,value){const pending=this.ackJobs.get(id),run=()=>this.sendFinal(owner,id,{kind:'text',text:value});return this.track(pending?pending.catch(()=>{}).then(run):run());}
  replyImage(owner,id,image,...unsupported){this.require(owner);if(unsupported.length)throw fail('image_only_final_required');if(!this.features.outboundImages)throw fail('outbound_images_disabled');const prepared=outboundImage(image),pending=this.ackJobs.get(id),run=()=>this.sendFinal(owner,id,{kind:'image',image:prepared,text:''});return this.track((pending?pending.catch(()=>{}).then(run):run()).finally(()=>prepared.bytes.fill(0)));}
  async sendFinal(owner,id,value){
    this.require(owner);if(value.kind==='text')text(value.text);else if(value.text!=='')throw fail('invalid_text');if(value.text.includes('\0'))throw fail('invalid_text');const {r,m}=this.validateRow(id),digest=value.kind==='text'?sha(value.text):sha(JSON.stringify(['image',sha(value.image.bytes),value.text]));
    if(r.reply_state!=='ready'){if(r.reply_state==='sent'&&r.reply_digest===digest){const prior=JSON.parse(r.reply_receipt);if((prior.response_kind??'text')===value.kind)return {...prior,duplicate:true};}throw fail('reply_already_claimed');}
    if(this.mode==='real'&&this.#account.consent.send!==true)throw fail('send_not_authorized');
    const simulated=this.mode==='mock',clientId='bridge_'+sha(id)+(value.kind==='image'?'_image':''),result={binding_id:simulated?'mock-binding':'real-binding',message_id:id,simulated,sent:!simulated,duplicate:false,client_id:clientId,response_kind:value.kind,quote_requested:!!this.quote(m).ref_msg,quote_visible_to_user:null};
    this.db.exec('BEGIN IMMEDIATE');try{
      const state=simulated?'sent':'sending',receipt=simulated?JSON.stringify(result):null;
      if(this.db.prepare("UPDATE messages SET reply_state=?,reply_digest=?,reply_receipt=? WHERE id=? AND reply_state='ready'").run(state,digest,receipt,id).changes!==1||this.db.prepare("UPDATE ledger SET reply_state=?,reply_digest=?,reply_receipt=? WHERE id=? AND reply_state='ready'").run(state,digest,receipt,id).changes!==1)throw fail('reply_already_claimed');
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    this.processing.final(id);if(simulated)return result;const generation=this.generation,sentAt=this.clock(),current=()=>{try{return this.current(generation)&&this.validateRow(id).r.value===r.value;}catch{return false;}};
    try{
      const acknowledged=[],accept=answer=>{const assigned=messageID(answer.message_id);return (answer.errcode===undefined||answer.errcode===0)&&(answer.ret===0||!Object.hasOwn(answer,'ret')&&assigned!==null&&assigned!=='0');};result.acknowledged_parts=acknowledged;
      if(value.kind==='image'){
        const image=await uploadImage({bytes:value.image.bytes,peer:this.#account.peer,api:(endpoint,body)=>this.api(endpoint,body),upload:this.#imageUpload,signal:this.abort.signal,current});
        if(!current())throw 0;
        // Image-only final: no implicit extra caption message.
        const response=await this.sendItems(m,[{...image,...this.quote(m)}],clientId);if(!accept(response)||!current())throw 0;acknowledged.push('image');
      }else{const response=await this.sendItems(m,[{type:1,text_item:{text:value.text},...this.quote(m)}],clientId);if(!accept(response)||!current())throw 0;acknowledged.push('text');this.quoteCache.recordSent(this.#account,messageID(response.message_id),value.text,sentAt);}
      result.acknowledged_at_ms=this.clock();this.finish(id,'sent',result);return result;
    }catch{this.finish(id,'uncertain',{simulated:false,sent:null,duplicate:false,reason:'send_result_uncertain',acknowledged_parts:result.acknowledged_parts??[]});throw fail('send_result_uncertain');}
  }
  acknowledge(owner,id,value){if(this.ackJobs.has(id))return Promise.reject(fail('acknowledgement_in_flight'));const job=this.ack(owner,id,value);this.ackJobs.set(id,job);job.finally(()=>{if(this.ackJobs.get(id)===job)this.ackJobs.delete(id);}).catch(()=>{});return this.track(job);}
  async ack(owner,id,value){
    this.require(owner);if(!this.features.acknowledgements)throw fail('acknowledgements_disabled');text(value);if(value.includes('\0'))throw fail('invalid_text');const {r,m}=this.validateRow(id),digest=sha(value),old=this.db.prepare('SELECT * FROM acknowledgements WHERE id=?').get(id);
    if(old){if(old.state==='sent'&&old.digest===digest)return {...JSON.parse(old.receipt),duplicate:true};throw fail('acknowledgement_already_claimed');}if(r.reply_state!=='ready')throw fail('reply_already_claimed');if(this.mode==='real'&&!this.#account.consent.send)throw fail('send_not_authorized');
    this.db.prepare("INSERT INTO acknowledgements VALUES(?,?,'sending',NULL)").run(id,digest);const generation=this.generation,result={binding_id:this.mode==='mock'?'mock-binding':'real-binding',message_id:id,phase:'ack',simulated:this.mode==='mock',sent:this.mode==='real',duplicate:false};
    try{if(this.mode==='real'){const answer=await this.sendItems(m,[{type:1,text_item:{text:value},...this.quote(m)}],'ack_'+sha(id)),assigned=messageID(answer.message_id);if(!this.current(generation)||(answer.errcode!==undefined&&answer.errcode!==0)||!(answer.ret===0||answer.ret===undefined&&assigned&&assigned!=='0'))throw 0;this.validateRow(id);}this.db.prepare("UPDATE acknowledgements SET state='sent',receipt=? WHERE id=?").run(JSON.stringify(result),id);return result;}catch{this.db.prepare("UPDATE acknowledgements SET state='uncertain' WHERE id=?").run(id);throw fail('send_result_uncertain');}
  }
  finish(id,state,receipt){this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('UPDATE messages SET reply_state=?,reply_receipt=? WHERE id=?').run(state,JSON.stringify(receipt),id);this.db.prepare('UPDATE ledger SET reply_state=?,reply_receipt=? WHERE id=?').run(state,JSON.stringify(receipt),id);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
  track(promise){this.jobs.add(promise);promise.finally(()=>this.jobs.delete(promise)).catch(()=>{});return promise;}
  start(){this.require(this.ownerHash);const pause=this.meta('provider_pause_until');if(pause>this.clock()){this.#account.pauseUntil=pause;throw fail('provider_session_paused');}this.active=true;this.notifications.cleanup();this.notifications.arm();this.kickEmit();if(this.mode==='real')this.schedulePoll(0);}
  schedulePoll(ms){this.cancelSchedule(this.pollTimer);if(!this.active||this.stopped)return;this.pollTimer=this.schedule(async()=>{const started=this.clock();try{await this.receiveOnce();}catch{}if(this.active&&!this.stopped)this.schedulePoll(this.clock()-started>=1000?0:1000);},ms);this.pollTimer?.unref?.();}
  kickEmit(){if(!this.active||this.stopped)return;this.cancelSchedule(this.retryTimer);this.retryTimer=null;void this.flush().catch(()=>{});}
  flush(){if(this.flushJob)return this.flushJob;if(!this.active||this.stopped)return Promise.resolve();this.flushJob=this.flushRows().finally(()=>{this.flushJob=null;this.armRetry();});return this.flushJob;}
  async flushRows(){
    if(!this.emitReady())return;const generation=this.generation;this.cleanup();
    for(const r of this.db.prepare('SELECT * FROM messages WHERE ingested=0 AND attempts<? AND retry_at<=? AND created>? ORDER BY created,id LIMIT 50').all(this.maxEmitAttempts,this.clock(),this.clock()-WINDOW_MS)){
      if(!this.current(generation)||!this.emitReady())return;try{this.validateRow(r.id,false);}catch{this.db.prepare('UPDATE messages SET attempts=? WHERE id=?').run(this.maxEmitAttempts,r.id);continue;}
      if(this.db.prepare('UPDATE messages SET attempts=attempts+1,retry_at=? WHERE id=? AND value=? AND ingested=0 AND attempts=?').run(this.clock()+Math.min(60000,1000*2**r.attempts),r.id,r.value,r.attempts).changes!==1)continue;
      let result;try{result=await this.emit({message_id:r.id},{signal:this.abort.signal});}catch{}
      if(result?.terminal===true){this.db.prepare('UPDATE messages SET attempts=? WHERE id=? AND value=? AND ingested=0').run(this.maxEmitAttempts,r.id,r.value);this.db.prepare("UPDATE ledger SET delivery_state='terminal' WHERE id=?").run(r.id);continue;}
      if(!this.current(generation))return;
      if(result?.accepted===true&&result.isCurrent?.()===true){this.db.exec('BEGIN IMMEDIATE');try{const changed=this.db.prepare('UPDATE messages SET ingested=1 WHERE id=? AND value=? AND ingested=0').run(r.id,r.value);if(changed.changes){this.db.prepare("UPDATE ledger SET delivery_state='delivered' WHERE id=?").run(r.id);this.notifications.record(this.unseal(r.value,'message:'+r.id));}this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
    }
  }
  armRetry(){this.cancelSchedule(this.retryTimer);this.retryTimer=null;if(!this.active||this.stopped||!this.emitReady())return;const r=this.db.prepare('SELECT MIN(retry_at) at FROM messages WHERE ingested=0 AND attempts<? AND created>?').get(this.maxEmitAttempts,this.clock()-WINDOW_MS);if(r?.at!=null){this.retryTimer=this.schedule(()=>this.kickEmit(),Math.max(1,r.at-this.clock()));this.retryTimer?.unref?.();}}
  status(){this.require(this.ownerHash);return {mode:this.mode,send_enabled:this.mode==='real'&&this.#account.consent.send===true,active:this.active,features:{...this.features},read_window_seconds:WINDOW_MS/1000};}
  stop(){if(this.stopped)return;this.stopped=true;this.active=false;this.generation++;this.abort.abort();this.processing?.stop();this.quoteCache?.stop();this.notifications?.stop();this.cancelSchedule(this.retryTimer);this.cancelSchedule(this.pollTimer);}
  revoke(){this.require(this.ownerHash);this.db.exec('BEGIN IMMEDIATE;UPDATE mcp_policy SET enabled=0;DELETE FROM messages;DELETE FROM message_timings;COMMIT;');this.quoteCache.invalidate();this.notifications.revoke();this.stop();}
  close(){return this.closeJob??=(async()=>{this.stop();await Promise.allSettled([...this.jobs,this.flushJob].filter(Boolean));await this.processing?.drain();this.db.close();this.lock.release();this.#key.fill(0);this.closed=true;})();}
}
