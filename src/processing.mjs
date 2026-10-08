import {BridgeError} from './security.mjs';
export const LEASE_MS=45000,HARD_MS=600000,RENEW_MS=4000,RECEIPT_MS=5000;
const fail=r=>new BridgeError(r,-32001),ticketOK=t=>typeof t==='string'&&t.length>0&&t.length<=8192&&/^[A-Za-z0-9+/_=-]+$/.test(t);

// Local work declarations are not evidence of model execution or visible UI.
// Provider tickets exist in memory only; a restart expires every running lease.
export class Processing {
 constructor(a){this.a=a;this.active=null;this.jobs=new Set();this.closed=false;this.timer=null;
  a.db.exec('CREATE TABLE IF NOT EXISTS processing(id TEXT PRIMARY KEY,phase TEXT NOT NULL,started INTEGER,lease_until INTEGER,hard_until INTEGER,updated INTEGER NOT NULL);');
  a.db.exec("UPDATE processing SET phase='expired',lease_until=NULL WHERE phase='running'");
  a.db.exec('CREATE TABLE IF NOT EXISTS receipt_typing(id TEXT PRIMARY KEY,attempted INTEGER NOT NULL);');
 }
 context(id){if(!this.a.features.processing||this.closed)throw fail('processing_disabled');const c=this.a.validateRow(id);if(this.a.mode==='real'&&!this.a.account().consent.send)throw fail('send_not_authorized');return c;}
 read(id){if(!this.a.features.processing)return null;const {r}=this.context(id),p=this.a.db.prepare('SELECT * FROM processing WHERE id=?').get(id);let phase=p?.phase??'queued';if(r.reply_state!=='ready')phase='completed';else if(phase==='running'&&(this.a.clock()>=p.lease_until||this.a.clock()>=p.hard_until))phase='expired';return {phase,started_at_ms:p?.started??null,lease_until_ms:phase==='running'?p.lease_until:null,hard_until_ms:p?.hard_until??null,lease_ms:LEASE_MS,hard_max_ms:HARD_MS,typing_visible_to_user:null,simulated:this.a.mode==='mock'};}
 running(id){try{return this.read(id)?.phase==='running';}catch{return false;}}
 track(job){this.jobs.add(job);job.finally(()=>this.jobs.delete(job)).catch(()=>{});return job;}
 async update(owner,id,phase){
  this.a.require(owner);if(!['running','waiting','completed','failed'].includes(phase))throw fail('processing_rejected');const {r}=this.context(id);if(r.reply_state!=='ready')throw fail('reply_already_claimed');const now=this.a.clock(),p=this.a.db.prepare('SELECT * FROM processing WHERE id=?').get(id);
  if(p&&['completed','failed'].includes(p.phase)){if(p.phase!==phase)throw fail('processing_terminal');return this.read(id);}
  if(phase==='running'){
   if(this.a.db.prepare("SELECT id FROM processing WHERE id<>? AND phase='running' AND lease_until>? AND hard_until>?").get(id,now,now))throw fail('processing_busy');
   const started=p?.started??now,hard=p?.hard_until??Math.min(started+HARD_MS,r.created+3600000);if(now>=hard)throw fail('processing_limit');
   this.a.db.prepare("INSERT INTO processing VALUES(?,'running',?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase='running',started=excluded.started,lease_until=excluded.lease_until,hard_until=excluded.hard_until,updated=excluded.updated").run(id,started,Math.min(now+LEASE_MS,hard),hard,now);
   if(this.active?.id!==id||this.active?.kind!=='work'){await this.finishActive();if(!this.running(id))throw fail('processing_cancelled');this.begin(id);}this.arm();
  }else{this.a.db.prepare('INSERT INTO processing(id,phase,updated) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,lease_until=NULL,updated=excluded.updated').run(id,phase,now);await this.finishActive(id);this.arm();}
  return this.read(id);
 }
 begin(id){if(!this.a.features.typing||this.a.mode==='mock'||!this.running(id)||this.closed)return;const {m}=this.context(id),e={id,kind:'work',generation:this.a.generation,abort:new AbortController(),ticket:null,dispatched:false,ending:false};this.active=e;e.startJob=this.track(this.start(e,m.context));}
 receipt(id){if(!this.a.features.receiptTyping||this.closed||this.a.stopped)return;let m,r;try{({m,r}=this.a.validateRow(id,false));}catch{return;}if(r.reply_state!=='ready'||this.a.mode==='real'&&!this.a.account().consent.send)return;
  const prior=this.a.db.prepare('SELECT max(attempted) at FROM receipt_typing').get()?.at,now=this.a.clock(),claim=this.a.db.prepare('INSERT OR IGNORE INTO receipt_typing VALUES(?,?)').run(id,now);if(!claim.changes||this.active||prior!=null&&now-prior<RECEIPT_MS||this.a.mode==='mock')return;
  const e={id,kind:'receipt',expires:Math.min(now+RECEIPT_MS,m.created+3600000),generation:this.a.generation,abort:new AbortController(),ticket:null,dispatched:false,ending:false};this.active=e;e.deadline=this.a.schedule(()=>void this.finishActive(id),Math.max(1,e.expires-now));e.deadline?.unref?.();e.startJob=this.track(this.start(e,m.context));
 }
 current(e,cancel=false){try{this.a.require(this.a.ownerHash);const {r}=this.a.validateRow(e.id,e.kind!=='receipt');return !this.closed&&this.active===e&&this.a.generation===e.generation&&(cancel||!e.ending&&r.reply_state==='ready'&&(e.kind==='receipt'?this.a.clock()<e.expires:this.running(e.id)));}catch{return false;}}
 async request(e,endpoint,body){return this.a.api(endpoint,body,{signal:AbortSignal.any([this.a.abort.signal,e.abort.signal]),timeoutMs:3000});}
 async start(e,context){try{
  if(!this.current(e))return;const r=await this.request(e,'/ilink/bot/getconfig',{ilink_user_id:this.a.account().peer,context_token:context});if(!this.current(e)||r.ret!==0||(r.errcode!==undefined&&r.errcode!==0)||!ticketOK(r.typing_ticket))return;
  e.ticket=r.typing_ticket;await this.pulse(e);
 }catch{/* Optional hint errors never become a final response or logs. */}}
 async pulse(e){if(!this.current(e))return;try{e.dispatched=true;const r=await this.request(e,'/ilink/bot/sendtyping',{ilink_user_id:this.a.account().peer,typing_ticket:e.ticket,status:1});if((r.ret!==undefined&&r.ret!==0)||(r.errcode!==undefined&&r.errcode!==0)||!this.current(e))return;if(e.kind==='work'){e.timer=this.a.schedule(()=>{e.pulseJob=this.track(this.pulse(e));},RENEW_MS);e.timer?.unref?.();}}catch{}}
 finishActive(id){const e=this.active;if(!e||id&&e.id!==id)return Promise.resolve();if(e.endJob)return e.endJob;e.ending=true;e.abort.abort();this.a.cancelSchedule(e.timer);this.a.cancelSchedule(e.deadline);
  e.endJob=this.track((async()=>{await e.startJob;await e.pulseJob;if(e.dispatched&&e.ticket&&this.current(e,true)){try{await this.a.api('/ilink/bot/sendtyping',{ilink_user_id:this.a.account().peer,typing_ticket:e.ticket,status:2},{timeoutMs:3000});}catch{}}e.ticket=null;if(this.active===e)this.active=null;})());return e.endJob;
 }
 final(id){this.a.db.prepare("UPDATE processing SET phase='completed',lease_until=NULL,updated=? WHERE id=?").run(this.a.clock(),id);void this.finishActive(id);this.arm();}
 arm(){this.a.cancelSchedule(this.timer);this.timer=null;if(this.closed)return;const at=this.a.db.prepare("SELECT min(lease_until) at FROM processing WHERE phase='running'").get()?.at;if(at!=null){this.timer=this.a.schedule(()=>{this.expire();},Math.max(1,at-this.a.clock()));this.timer?.unref?.();}}
 expire(){if(this.closed)return;const rows=this.a.db.prepare("SELECT id FROM processing WHERE phase='running' AND (lease_until<=? OR hard_until<=?)").all(this.a.clock(),this.a.clock());for(const r of rows){this.a.db.prepare("UPDATE processing SET phase='expired',lease_until=NULL WHERE id=?").run(r.id);void this.finishActive(r.id);}this.arm();}
 stop(){if(this.closed)return;this.closed=true;this.a.cancelSchedule(this.timer);const e=this.active;if(e){e.ending=true;e.abort.abort();this.a.cancelSchedule(e.timer);this.a.cancelSchedule(e.deadline);}this.a.db.exec("UPDATE processing SET phase='expired',lease_until=NULL WHERE phase='running'");}
 async drain(){while(this.jobs.size)await Promise.allSettled([...this.jobs]);if(this.active)this.active.ticket=null;this.active=null;}
}
