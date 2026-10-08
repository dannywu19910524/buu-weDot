import {createHash} from 'node:crypto';
import {messageID} from './weixin-transport.mjs';
import {quoteSnippet} from './quotes.mjs';
export const QUOTE_CACHE_POLICY='owner-text-1h-v1';
export const QUOTE_CACHE_TTL=3600000,QUOTE_CACHE_CAPACITY=512;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const scope=(owner,a)=>hash([owner,a.bot,a.peer,a.boundAt]);
const idOK=v=>typeof v==='string'&&messageID(v)===v&&v!=='0';
const textOK=v=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=8192&&!v.includes('\0');
const timeOK=(a,t,now)=>Number.isSafeInteger(t)&&t>=a.boundAt&&t<=now&&now<t+QUOTE_CACHE_TTL;
// Only the explicitly configured original owner/bot conversation. No media.
// Config opt-in is local authorization; incoming text can never enable this.
export class OwnerQuoteTextCache{
 constructor(a,{enabled=false,schedule=setTimeout,cancelSchedule=clearTimeout}={}){
  this.a=a;this.enabled=enabled===true;this.schedule=schedule;this.cancelSchedule=cancelSchedule;this.timer=null;this.closed=false;
  if(!this.enabled||!a.enabled)return;
  a.db.exec('PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS quote_text_cache(key TEXT PRIMARY KEY,scope TEXT NOT NULL,created INTEGER NOT NULL,value TEXT NOT NULL,conflict INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS quote_text_cache_expiry ON quote_text_cache(created);');this.cleanup();this.arm();
 }
 account({active=true}={}){
  if(!this.enabled||this.closed||!this.a.enabled||this.a.stopped)return null;
  try{this.a.require(this.a.ownerHash);const a=this.a.account();return a?.consent?.receive===true&&(!active||(a.pauseUntil??0)<=this.a.clock())?a:null;}catch{return null;}
 }
 cleanup(){
  if(!this.enabled||this.closed)return;const a=this.account({active:false}),now=this.a.clock();
  if(!a)this.a.db.exec('DELETE FROM quote_text_cache');else this.a.db.prepare('DELETE FROM quote_text_cache WHERE scope<>? OR created<=? OR created>?').run(scope(this.a.ownerHash,a),now-QUOTE_CACHE_TTL,now);
 }
 arm(){
  if(!this.enabled||this.closed)return;if(this.timer)this.cancelSchedule(this.timer);this.timer=null;
  const first=this.a.db.prepare('SELECT min(created) created FROM quote_text_cache').get()?.created;if(first===null||first===undefined)return;
  const delay=Math.max(1,Math.min(QUOTE_CACHE_TTL,first+QUOTE_CACHE_TTL-this.a.clock()));this.timer=this.schedule(()=>{this.timer=null;try{this.cleanup();this.arm();}catch{/* No raw exceptions or private data enter logs. */}},delay);this.timer?.unref?.();
 }
 put(account,wireID,text,created,direction){
  const a=this.account();if(!a||scope(this.a.ownerHash,a)!==scope(this.a.ownerHash,account)||!idOK(wireID)||!textOK(text)||!['inbound','outbound'].includes(direction)||!timeOK(a,created,this.a.clock()))return false;
  const s=scope(this.a.ownerHash,a),key=hash([s,wireID]),existing=this.a.db.prepare('SELECT * FROM quote_text_cache WHERE key=?').get(key);
  if(existing){if(existing.conflict)return false;const old=this.a.unseal(existing.value,'quote-text-cache:'+key);if(old.wire_id!==wireID||old.text!==text||old.direction!==direction)this.a.db.prepare('UPDATE quote_text_cache SET conflict=1,value=? WHERE key=?').run(this.a.seal({conflict:true},'quote-text-cache:'+key),key);return false;}
  this.a.db.prepare('INSERT INTO quote_text_cache(key,scope,created,value) VALUES(?,?,?,?)').run(key,s,created,this.a.seal({policy:QUOTE_CACHE_POLICY,scope:s,wire_id:wireID,text,created,direction},'quote-text-cache:'+key));this.a.db.exec(`DELETE FROM quote_text_cache WHERE key IN (SELECT key FROM quote_text_cache ORDER BY created DESC,key LIMIT -1 OFFSET ${QUOTE_CACHE_CAPACITY})`);return true;
 }
 find(account,wireID){
  this.cleanup();const a=this.account();if(!a||scope(this.a.ownerHash,a)!==scope(this.a.ownerHash,account)||!idOK(wireID))return null;
  const s=scope(this.a.ownerHash,a),key=hash([s,wireID]),row=this.a.db.prepare('SELECT * FROM quote_text_cache WHERE key=? AND scope=? AND conflict=0 AND created>? AND created>=? AND created<=?').get(key,s,this.a.clock()-QUOTE_CACHE_TTL,a.boundAt,this.a.clock());if(!row)return null;
  const v=this.a.unseal(row.value,'quote-text-cache:'+key);if(v.policy!==QUOTE_CACHE_POLICY||v.scope!==s||v.wire_id!==wireID||v.created!==row.created||!textOK(v.text)||!['inbound','outbound'].includes(v.direction))return null;return v;
 }
 resolve(account,quote){
  if(!quote||quote.text!==null||!['unknown','text'].includes(quote.message_type)||!idOK(quote.reference_id)||!this.account())return quote;
  const v=this.find(account,quote.reference_id),resolution={status:v?'resolved':'not_found',source:'same_conversation_text_cache',policy:QUOTE_CACHE_POLICY};
  if(!v)return {...quote,history_lookup_performed:true,resolution};const body=quoteSnippet(v.text,4096);
  return {...quote,message_type:'text',text:body.text,content_status:'cached_text',truncated:quote.truncated||body.truncated,history_lookup_performed:true,resolution:{...resolution,source_created_at_ms:v.created,expires_at_ms:v.created+QUOTE_CACHE_TTL,original_direction:v.direction}};
 }
 recordSent(account,wireID,text,created){try{this.cleanup();this.put(account,wireID,text,created,'outbound');this.arm();}catch{/* Cache failure must never change a completed send or permit retry. */}}
 status(){return {enabled:!!this.account(),policy:QUOTE_CACHE_POLICY,retention_ms:QUOTE_CACHE_TTL,media_cached:false,max_records:QUOTE_CACHE_CAPACITY};}
 invalidate(){if(!this.enabled)return;this.a.db.exec('DELETE FROM quote_text_cache');if(this.timer)this.cancelSchedule(this.timer);this.timer=null;}
 stop(){this.closed=true;if(this.timer)this.cancelSchedule(this.timer);this.timer=null;}
}
