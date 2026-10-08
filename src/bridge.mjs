import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {pinnedPost} from './pinned-https.mjs';
import {BridgeError,object,sign,signingKey,callbackURL,EVENT,text,equal} from './security.mjs';
import {inboundQuoteProjection} from './quote-projection.mjs';
import {MCP_RESULT_LIMIT} from './features.mjs';
import {definitionsFor} from './contracts.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const iso=n=>new Date(n).toISOString();
const pack=(data,image)=>({content:[{type:'text',text:JSON.stringify(data)},...(image?[image]:[])],structuredContent:data,isError:false});

// One canonical encrypted messages row is also the event outbox. Subscription
// metadata is the only new durable state; no duplicated message body or claim.
export class Bridge {
  constructor({adapter,auth,mode='mock',callbackHosts=[],callback,injectSynthetic,subscriptionTable='mcp_subscription',attachEmitter=true}){
    if(!['mock','real'].includes(mode)||adapter.mode!==mode||!adapter.enabled||adapter.ownerHash!==auth.ownerHash||callbackHosts.some(h=>!/^[a-z0-9.-]+\.[a-z]+$/.test(h)))throw new Error('configuration_required');
    if(!['mcp_subscription','mcp_mock_subscription'].includes(subscriptionTable))throw new Error('configuration_required');this.subscriptionTable=subscriptionTable;
    this.a=adapter;this.auth=auth;this.mode=mode;this.binding=mode==='mock'?'mock-binding':'real-binding';this.hosts=[...callbackHosts];this.injectSynthetic=mode==='mock'?injectSynthetic:undefined;
    this.callback=callback??((url,headers,body,options)=>pinnedPost(url,headers,body,{trustedHosts:this.hosts,...options}));
    this.subscriptionJobs=new Set();this.epoch=0;this.abort=new AbortController();this.subscribing=false;
    adapter.db.exec('CREATE TABLE IF NOT EXISTS '+this.subscriptionTable+'(slot INTEGER PRIMARY KEY CHECK(slot=1),ciphertext TEXT NOT NULL);');
    adapter.db.exec('CREATE TABLE IF NOT EXISTS mcp_policy(slot INTEGER PRIMARY KEY CHECK(slot=1),enabled INTEGER NOT NULL);INSERT OR IGNORE INTO mcp_policy VALUES(1,1);');
    // Schema contains timestamps/status only, not another event payload.
    const cols=new Set(adapter.db.prepare('PRAGMA table_info(message_timings)').all().map(c=>c.name));
    for(const c of ['callback_started_ms','callback_received_ms','callback_status'])if(!cols.has(c))adapter.db.exec('ALTER TABLE message_timings ADD COLUMN '+c+' INTEGER');
    if(attachEmitter){adapter.maxEmitAttempts=mode==='real'?6:3;adapter.emitReady=()=>{try{this.require();return !!this.subscription();}catch{return false;}};
    adapter.emit=(payload,options)=>this.deliver(payload.message_id,options);}
  }
  require(){this.a.require(this.auth.ownerHash);if(!this.a.db.prepare('SELECT enabled FROM mcp_policy WHERE slot=1').get()?.enabled)throw new BridgeError('not_authorized',-32001);}
  // Internal absolute authorization bound, never accepted from RPC arguments.
  subscriptionDeadline(){return Infinity;}
  subscription(){
    const row=this.a.db.prepare('SELECT ciphertext FROM '+this.subscriptionTable+' WHERE slot=1').get();
    if(!row)return null;const sub={...this.a.unseal(row.ciphertext,'subscription:'+this.auth.ownerHash+':'+this.binding),revision:row.ciphertext};
    if(sub.expires<=this.a.clock()){this.clearSubscription();return null;}return sub;
  }
  saveSubscription(value){this.a.db.prepare('INSERT INTO '+this.subscriptionTable+' VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET ciphertext=excluded.ciphertext').run(this.a.seal(value,'subscription:'+this.auth.ownerHash+':'+this.binding));this.armExpiry();}
  invalidate(){this.epoch++;this.abort.abort();this.abort=new AbortController();this.a.cancelSchedule(this.expiryTimer);this.expiryTimer=null;}
  clearSubscription(){this.invalidate();this.a.db.exec('DELETE FROM '+this.subscriptionTable);}
  armExpiry(){this.a.cancelSchedule(this.expiryTimer);this.expiryTimer=null;const sub=this.subscription();if(sub&&!this.a.stopped){this.expiryTimer=this.a.schedule(()=>{try{this.subscription();}catch{this.invalidate();this.a.stop();}},Math.max(1,sub.expires-this.a.clock()));this.expiryTimer?.unref?.();}}
  eventID(id){return 'evt_'+hash(JSON.stringify([this.auth.canonicalOwner,this.binding,id]));}
  sid(url){return 'sub_'+hash(JSON.stringify([this.auth.canonicalOwner,url,EVENT,{binding_id:this.binding}]));}
  filter(p){if(p.name!==EVENT)throw new BridgeError('unknown_event');const a=object(p.arguments,['binding_id']);if(a.binding_id!==this.binding)throw new BridgeError('not_authorized',-32001);}
  async headers(s,id,body){
    const stamp=Math.floor(this.a.clock()/1000);let signature=await sign(s.secret,id,stamp,body);
    if(s.oldSecret&&s.rotateUntil>this.a.clock())signature+=' '+await sign(s.oldSecret,id,stamp,body);
    return {'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':String(stamp),'webhook-signature':signature,'X-MCP-Subscription-Id':s.sid};
  }
  subscribe(raw){const job=this.subscribeRequest(raw);this.subscriptionJobs.add(job);job.finally(()=>this.subscriptionJobs.delete(job)).catch(()=>{});return job;}
  async subscribeRequest(raw){
    this.require();if(this.subscribing)throw new BridgeError('subscription_busy');
    const p=object(raw,['name','arguments','delivery'],['cursor','ttlMs']);this.filter(p);
    if(p.cursor!=null)throw new BridgeError('replay_not_supported');
    const d=object(p.delivery,['mode','url','secret']);if(d.mode!=='webhook')throw new BridgeError('unsupported_delivery');
    signingKey(d.secret);const url=callbackURL(d.url,this.hosts),sid=this.sid(url),old=this.subscription(),requested=p.ttlMs??3600000;
    if(typeof requested!=='number'||!Number.isFinite(requested)||requested<=0)throw new BridgeError('invalid_ttl');
    if(old&&old.sid!==sid)throw new BridgeError('binding_already_subscribed',-32001);
    const now=this.a.clock(),deadline=this.subscriptionDeadline();
    if(deadline!==Infinity&&(!Number.isSafeInteger(deadline)||deadline<=now))throw new BridgeError('not_authorized',-32001);
    const s={sid,url,secret:d.secret,expires:Math.min(deadline,now+Math.max(1000,Math.min(3600000,Math.floor(requested))))};
    if(old&&old.secret!==s.secret){s.oldSecret=old.secret;s.rotateUntil=this.a.clock()+300000;}
    else if(old?.oldSecret&&old.rotateUntil>this.a.clock()){s.oldSecret=old.oldSecret;s.rotateUntil=old.rotateUntil;}
    const epoch=this.epoch,generation=this.a.generation,signal=AbortSignal.any([this.abort.signal,this.a.abort.signal]);
    this.subscribing=true;this.pendingSID=sid;
    try{
      if(old?.secret===s.secret&&old.verifiedUntil>this.a.clock())s.verifiedUntil=old.verifiedUntil;
      else{
        const challenge=randomBytes(24).toString('base64'),body=JSON.stringify({type:'verification',challenge}),start=this.a.clock();
        const headers=await this.headers(s,'verify_'+randomUUID(),body);
        if(signal.aborted||epoch!==this.epoch)throw new BridgeError('subscription_cancelled');
        const r=await this.callback(url,headers,body,{signal});
        let echo;try{echo=JSON.parse(r.body).challenge;}catch{}
        if(r.status<200||r.status>=300||typeof echo!=='string'||!equal(echo,challenge)||this.a.clock()-start>30000)throw new BridgeError('challenge_failed',-32015);
        s.verifiedUntil=this.a.clock()+300000;
      }
      this.require();
      s.expires=Math.min(s.expires,this.subscriptionDeadline());
      if(signal.aborted||epoch!==this.epoch||generation!==this.a.generation||s.expires<=this.a.clock())throw new BridgeError('subscription_cancelled');
      // A verified renewal of the same destination does not abort valid events.
      this.saveSubscription(s);this.a.kickEmit();
      return {id:sid,refreshBefore:iso(s.expires),cursor:null,truncated:false};
    }catch(e){if(e instanceof BridgeError)throw e;throw new BridgeError('callback_endpoint_error',-32015);}
    finally{this.subscribing=false;this.pendingSID=null;}
  }
  unsubscribe(raw){
    this.require();const p=object(raw,['name','arguments','delivery']);this.filter(p);const d=object(p.delivery,['mode','url']);
    if(d.mode!=='webhook')throw new BridgeError('unsupported_delivery');const sid=this.sid(callbackURL(d.url,this.hosts)),s=this.subscription();
    if(s&&s.sid===sid){this.clearSubscription();}
    // Cancel even an in-flight first verification for this exact destination.
    else if(!s&&this.pendingSID===sid){this.clearSubscription();}
    return {};
  }
  snapshot(id,delivered=true){
    this.require();if(typeof id!=='string'||!/^wx_[a-f0-9]{64}$/.test(id))throw new BridgeError('message_not_available',-32001);
    const {r,m}=this.a.validateRow(id,delivered),account=this.a.account();
    return {r,m,account,generation:this.a.generation,epoch:this.epoch};
  }
  unchanged(s){try{const t=this.snapshot(s.r.id,false);return t.r.value===s.r.value&&t.generation===s.generation&&t.epoch===s.epoch&&t.account.token===s.account.token&&t.account.boundAt===s.account.boundAt;}catch{return false;}}
  event(s){return {eventId:this.eventID(s.r.id),name:EVENT,timestamp:iso(s.m.created),data:{binding_id:this.binding,message_id:s.r.id,text:s.m.text,nonce:s.m.mockNonce??'',mode:this.mode==='mock'?'mock-only':'real'},cursor:null};}
  async deliver(id,{signal}={}){
    this.require();const sub=this.subscription();if(!sub)return {accepted:false};const s=this.snapshot(id,false),body=JSON.stringify(this.event(s));
    const combined=AbortSignal.any([signal??this.a.abort.signal,this.abort.signal]);let status=0;
    const headers=await this.headers(sub,this.eventID(id),body);
    if(combined.aborted||!this.unchanged(s))return {accepted:false};
    this.a.db.prepare('UPDATE message_timings SET callback_started_ms=? WHERE id=?').run(this.a.clock(),id);
    try{status=(await this.callback(sub.url,headers,body,{signal:combined})).status;}catch{/* No raw network error can escape into logs or tools. */}
    if(combined.aborted||!this.unchanged(s)||this.subscription()?.sid!==sub.sid)return {accepted:false};
    this.a.db.prepare('UPDATE message_timings SET callback_received_ms=?,callback_status=? WHERE id=?').run(this.a.clock(),Number.isInteger(status)&&status>=100&&status<=599?status:0,id);
    if([401,403,410].includes(status)){this.clearSubscription();}
    return {accepted:status>=200&&status<300,isCurrent:()=>!combined.aborted&&this.unchanged(s)&&this.subscription()?.sid===sub.sid,terminal:!!status&&status<500&&status!==429&&!(status>=200&&status<300)};
  }
  bound(raw,required,optional=[]){const p=object(raw,['binding_id',...required],optional);if(p.binding_id!==this.binding)throw new BridgeError('not_authorized',-32001);return p;}
  pending(raw){
    this.require();const p=this.bound(raw,[],['limit','cursor']),limit=p.limit??25,now=this.a.clock();if(!Number.isInteger(limit)||limit<1||limit>50)throw new BridgeError('invalid_arguments');
    let c={asOf:now,expires:now+300000},before;
    if(p.cursor!==undefined){
      try{
        if(typeof p.cursor!=='string'||p.cursor.length>4096)throw 0;c=this.a.unseal(p.cursor,'mcp:cursor:'+this.auth.ownerHash+':'+this.binding);
        if(![c.asOf,c.expires,c.created,c.rowid].every(Number.isSafeInteger)||c.expires!==c.asOf+300000||c.expires<=now||c.asOf>now||c.rowid<1||typeof c.id!=='string'||typeof c.anchor!=='string')throw 0;
        if(!this.a.db.prepare('SELECT 1 FROM messages WHERE rowid=? AND id=?').get(c.rowid,c.anchor))throw 0;
        before=c;
      }catch{throw new BridgeError('invalid_cursor');}
    }else{const last=this.a.db.prepare('SELECT rowid,id FROM messages ORDER BY rowid DESC LIMIT 1').get();c.rowid=last?.rowid??0;c.anchor=last?.id??'';}
    const rows=this.a.db.prepare("SELECT id,created FROM messages WHERE ingested=1 AND reply_state='ready' AND created>? AND created<=? AND rowid<=?"+(before?' AND (created<? OR (created=? AND id<?))':'')+' ORDER BY created DESC,id DESC LIMIT ?').all(now-3600000,c.asOf,c.rowid,...(before?[c.created,c.created,c.id]:[]),limit+1);
    const page=rows.slice(0,limit),more=rows.length>limit,last=page.at(-1);
    // Metadata still obeys the current binding and consent gate.
    const messages=page.map(r=>{this.snapshot(r.id);return {binding_id:this.binding,message_id:r.id,event_id:this.eventID(r.id),created_at:iso(r.created),read_expires_at:iso(r.created+3600000)};});
    return {binding_id:this.binding,messages,body_included:false,read_window_seconds:3600,order:'newest_first',page_limit:limit,as_of:iso(c.asOf),read_at_ms:now,has_more:more,next_cursor:more?this.a.seal({...c,created:last.created,id:last.id},'mcp:cursor:'+this.auth.ownerHash+':'+this.binding):null};
  }
  async get(raw){const p=this.bound(raw,['message_id']);return this.readSnapshot(this.snapshot(p.message_id));}
  async readSnapshot(s){let block,media={};if(s.m.kind==='image'){media={image_status:'unavailable'};try{const v=await this.a.readImage(this.auth.ownerHash,s.r.id);block={type:'image',mimeType:v.mime_type,data:v.data};media={image_status:'available',image:{mime_type:v.mime_type,width:v.width,height:v.height}};}catch{}}
    return pack({...this.project(s),...media},block);
  }
  async readPending(raw){
    const p=this.bound(raw,[],['limit']),limit=p.limit??3;if(!Number.isInteger(limit)||limit<1||limit>3)throw new BridgeError('invalid_arguments');const page=this.pending({binding_id:this.binding,limit}),snapshots=page.messages.map(x=>this.snapshot(x.message_id)),reads=[];
    for(const s of snapshots)reads.push(await this.readSnapshot(s));
    const images=[],messages=snapshots.map((s,i)=>{const v=this.project(s),prior=reads[i].structuredContent,indexes=[];for(const block of reads[i].content.filter(x=>x.type==='image')){images.push(block);indexes.push(images.length);}return {...v,...(s.m.kind==='image'?{image_status:prior.image_status,...(prior.image?{image:prior.image}:{})}:{}),ready:v.replyable,native_image_content_indexes:indexes};});
    const data={binding_id:this.binding,selection:'independent_pending_messages',messages,has_more:page.has_more,read_at_ms:this.a.clock(),claim_performed:false,send_performed:false},result={content:[{type:'text',text:JSON.stringify(data)},...images],structuredContent:data,isError:false};if(Buffer.byteLength(JSON.stringify(result))>MCP_RESULT_LIMIT)throw new BridgeError('batch_response_too_large',-32015);return result;
  }
  project(s){
    if(!this.unchanged(s))throw new BridgeError('message_not_available',-32001);
    const receipt=this.a.receipt(this.auth.ownerHash,s.r.id),timing=this.a.db.prepare('SELECT * FROM message_timings WHERE id=?').get(s.r.id),claimed=receipt.send_state!=='ready';
    const stages={source_created_ms:s.m.created};for(const field of ['received_ms','committed_ms','callback_started_ms','callback_received_ms','callback_status'])if(Number.isSafeInteger(timing?.[field]))stages[field]=timing[field];
    let processing;try{processing=this.a.processing.read(s.r.id);}catch{}const q=s.m.inboundQuote,quote=q?.quote?this.a.quoteCache.resolve(s.account,q.quote):null;
    return {...this.event(s).data,message_kind:s.m.kind,...inboundQuoteProjection({inbound_quote_status:q?.status??'not_captured',inbound_quote:quote},this.a.clock()),...(processing?{processing_state:processing}:{}),event_id:this.eventID(s.r.id),timestamp:iso(s.m.created),delivered:true,simulated:this.mode==='mock',sent:this.mode==='mock'?false:receipt.sent,send_state:receipt.send_state,reply_claimed:claimed,replyable:!claimed,read_expires_at:iso(s.m.created+3600000),reply_acknowledged_at_ms:receipt.reply_acknowledged_at_ms,stages};
  }
  status(){this.require();return {...this.a.status(),binding_id:this.binding,subscription_active:!!this.subscription(),pending_messages:this.pending({binding_id:this.binding}).messages};}
  async call(method,raw){
    this.require();if(method==='events/subscribe')return this.subscribe(raw);if(method==='events/unsubscribe')return this.unsubscribe(raw);
    if(method!=='tools/call')throw new BridgeError('method_not_found',-32601);const p=object(raw,['name','arguments']);let result;
    switch(p.name){
      case 'bridge_status':object(p.arguments,[]);result=this.status();break;
      case 'list_pending_weixin':result=this.pending(p.arguments);break;
      case 'get_message':return this.get(p.arguments);
      case 'read_pending_weixin':return this.readPending(p.arguments);
      case 'reply_weixin_image':{const a=this.bound(p.arguments,['message_id','image']);this.snapshot(a.message_id);result=await this.a.replyImage(this.auth.ownerHash,a.message_id,a.image);break;}
      case 'acknowledge_weixin':{const a=this.bound(p.arguments,['message_id','text']);this.snapshot(a.message_id);result=await this.a.acknowledge(this.auth.ownerHash,a.message_id,text(a.text));break;}
      case 'processing_weixin':{const a=this.bound(p.arguments,['message_id','phase']);this.snapshot(a.message_id);result={binding_id:this.binding,message_id:a.message_id,processing_state:await this.a.track(this.a.processing.update(this.auth.ownerHash,a.message_id,a.phase)),sent:false,simulated:this.mode==='mock'};break;}
      case 'notify_owner':{const a=this.bound(p.arguments,['notification_id','text','created_ms','expires_ms']);delete a.binding_id;result={binding_id:this.binding,...await this.a.notifications.notify(this.auth.ownerHash,a)};break;}
      case 'notification_status':{const a=this.bound(p.arguments,[],['notification_id']);result={binding_id:this.binding,...this.a.notifications.read(this.auth.ownerHash,a.notification_id)};break;}
      case 'reply_weixin':{const a=this.bound(p.arguments,['message_id','text']);this.snapshot(a.message_id);result=await this.a.reply(this.auth.ownerHash,a.message_id,text(a.text));break;}
      case 'mock_weixin_inbound':{if(this.mode!=='mock')throw new BridgeError('synthetic_binding_required',-32001);const a=this.bound(p.arguments,['message_id','nonce'],['kind','quote']);if(!this.subscription())throw new BridgeError('subscription_required',-32001);result=this.a.inject(a);result.event_id=this.eventID(result.message_id);break;}
      case 'pump_mock_events':object(p.arguments,[]);if(this.mode!=='mock')throw new BridgeError('synthetic_binding_required',-32001);await this.a.flush();result={simulated:true,sent:false};break;
      default:throw new BridgeError('unknown_tool');
    }
    return pack(result);
  }
  definitions(){return definitionsFor(this.mode);}
  start(){this.a.start();this.armExpiry();}
  close(){return this.closeJob??=(async()=>{this.invalidate();this.a.stop();await Promise.allSettled([...this.subscriptionJobs]);await this.a.close();})();}
}
