import {BridgeError} from './security.mjs';
import {messageID} from './weixin-transport.mjs';
const fail=r=>new BridgeError(r,-32001),idOK=id=>typeof id==='string'&&/^notify_[a-f0-9]{64}$/.test(id);
export class Notifications {
 constructor(a){this.a=a;this.timer=null;
  a.db.exec("CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,digest TEXT NOT NULL,created INTEGER NOT NULL,attempt_at INTEGER,state TEXT NOT NULL,reason TEXT NOT NULL,receipt TEXT);CREATE TABLE IF NOT EXISTS notification_context(slot INTEGER PRIMARY KEY CHECK(slot=1),created INTEGER NOT NULL,value TEXT NOT NULL);UPDATE notifications SET state='uncertain',reason='process_restarted' WHERE state='sending';");
  if(!a.features.notifications)a.db.exec('DELETE FROM notification_context');else if(a.meta('notification_enabled_at')===null)a.saveMeta('notification_enabled_at',a.clock());
 }
 record(m){if(!this.a.features.notifications)return;const a=this.a.account(),now=this.a.clock();if(m.bot!==a.bot||m.peer!==a.peer||m.created<a.boundAt||m.created>now||now>=m.created+this.a.features.notificationContextMs||this.a.mode==='real'&&typeof m.context!=='string')return;
  const old=this.a.db.prepare('SELECT created FROM notification_context WHERE slot=1').get();if(old&&old.created>=m.created)return;this.a.db.prepare('INSERT INTO notification_context VALUES(1,?,?) ON CONFLICT(slot) DO UPDATE SET created=excluded.created,value=excluded.value').run(m.created,this.a.seal({id:m.id,bot:m.bot,peer:m.peer,created:m.created,context:m.context??null},'notification-context'));this.arm();
 }
 cleanup(){this.a.db.prepare('DELETE FROM notification_context WHERE created<=? OR created>?').run(this.a.clock()-this.a.features.notificationContextMs,this.a.clock());}
 arm(){this.a.cancelSchedule(this.timer);this.timer=null;if(this.a.stopped)return;const row=this.a.db.prepare('SELECT created FROM notification_context WHERE slot=1').get();if(row){this.timer=this.a.schedule(()=>{this.cleanup();this.arm();},Math.max(1,row.created+this.a.features.notificationContextMs-this.a.clock()));this.timer?.unref?.();}}
 ready(){this.a.require(this.a.ownerHash);const a=this.a.account();if(!this.a.features.notifications||this.a.mode==='real'&&!a.consent.send)return {reason:'notification_not_enabled'};
  if(this.a.db.prepare("SELECT 1 FROM notifications WHERE state IN ('sending','uncertain') LIMIT 1").get())return {reason:'prior_attempt_unresolved'};
  const row=this.a.db.prepare('SELECT * FROM notification_context WHERE slot=1').get();if(!row)return {reason:'context_missing'};const m=this.a.unseal(row.value,'notification-context');
  if(m.created!==row.created||m.bot!==a.bot||m.peer!==a.peer||m.created<a.boundAt||m.created>this.a.clock())return {reason:'context_binding_mismatch'};
  if(this.a.clock()>=m.created+this.a.features.notificationContextMs)return {reason:'context_local_stale'};
  if(this.a.db.prepare('SELECT 1 FROM notifications WHERE attempt_at>? LIMIT 1').get(this.a.clock()-60000))return {reason:'local_rate_limit'};
  return {reason:'eligible',m};
 }
 project(r){return {notification_id:r.id,send_state:r.state,sent:r.state==='sent'?this.a.mode==='real':['sending','uncertain'].includes(r.state)?null:false,simulated:this.a.mode==='mock',reason:r.reason,attempted:r.attempt_at!==null,receipt:r.receipt?JSON.parse(r.receipt):null};}
 read(owner,id){this.a.require(owner);if(id!==undefined&&!idOK(id))throw fail('notification_rejected');const ready=this.ready(),row=id?this.a.db.prepare('SELECT * FROM notifications WHERE id=?').get(id):null;return {enabled:this.a.features.notifications,state:ready.reason==='eligible'?'eligible':'blocked',reason:ready.reason,local_context_max_age_ms:this.a.features.notificationContextMs,provider_validity:'unknown',provider_expires_at:null,notification:row?this.project(row):null};}
 notify(owner,p){return this.a.track(this.send(owner,p));}
 async send(owner,p){
  this.a.require(owner);if(!p||Object.getPrototypeOf(p)!==Object.prototype||Object.keys(p).sort().join(',')!=='created_ms,expires_ms,notification_id,text'||!idOK(p.notification_id)||typeof p.text!=='string'||!p.text.trim()||Buffer.byteLength(p.text)>4096||p.text.includes('\0')||![p.created_ms,p.expires_ms].every(x=>Number.isSafeInteger(x)&&x>=0))throw fail('notification_rejected');
  const digest=this.a.digest(JSON.stringify([p.text,p.created_ms,p.expires_ms])),old=this.a.db.prepare('SELECT * FROM notifications WHERE id=?').get(p.notification_id);if(old){if(old.digest!==digest)throw fail('notification_conflict');return {...this.project(old),duplicate:true};}
  if(this.a.db.prepare('SELECT count(*) n FROM notifications').get().n>=10000)throw fail('notification_capacity');const now=this.a.clock(),ready=this.ready();let reason=ready.reason;
  if(p.created_ms<(this.a.meta('notification_enabled_at')??now)||p.created_ms>now||p.expires_ms<=now||p.expires_ms<=p.created_ms||p.expires_ms-p.created_ms>300000||now-p.created_ms>300000)reason='notification_time_rejected';
  const allowed=reason==='eligible';this.a.db.prepare('INSERT INTO notifications VALUES(?,?,?,?,?,?,NULL)').run(p.notification_id,digest,p.created_ms,allowed?now:null,allowed?'sending':'blocked',allowed?'attempt_claimed':reason);
  if(!allowed)return {...this.project(this.a.db.prepare('SELECT * FROM notifications WHERE id=?').get(p.notification_id)),duplicate:false};
  let state='uncertain',receipt=null;const generation=this.a.generation,m=ready.m,current=()=>this.a.current(generation)&&this.a.clock()<m.created+this.a.features.notificationContextMs&&this.a.clock()<p.expires_ms;
  try{
   if(!current())throw 0;
   if(this.a.mode==='real'){
    const r=await this.a.sendItems(m,[{type:1,text_item:{text:p.text}}],'notify_'+this.a.digest(p.notification_id));const assigned=messageID(r.message_id);if(!current()||(r.errcode!==undefined&&r.errcode!==0)||!(r.ret===0||r.ret===undefined&&assigned&&assigned!=='0'))throw 0;
    this.a.quoteCache.recordSent(this.a.account(),assigned,p.text,now);
   }
   state='sent';reason=this.a.mode==='mock'?'simulated':'provider_acknowledged';receipt={result:reason,observed_at_ms:this.a.clock()};
  }catch{reason='send_result_uncertain';receipt={result:'uncertain',observed_at_ms:this.a.clock()};}
  this.a.db.prepare('UPDATE notifications SET state=?,reason=?,receipt=? WHERE id=?').run(state,reason,JSON.stringify(receipt),p.notification_id);return {...this.project(this.a.db.prepare('SELECT * FROM notifications WHERE id=?').get(p.notification_id)),duplicate:false};
 }
 stop(){this.a.cancelSchedule(this.timer);this.timer=null;}
 revoke(){this.stop();this.a.db.exec('DELETE FROM notification_context');}
}
