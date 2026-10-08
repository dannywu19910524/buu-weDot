import {API_HOST,apiBase,pinnedJSON} from './weixin-transport.mjs';
import {randomBytes} from 'node:crypto';
const clean=(v,n=512)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\x00-\x1f\x7f]/.test(v);
// Local-only enrollment, deliberately absent from the MCP tools. Calling
// start requires an explicit enable and consent; construction opens no socket.
export class Enrollment {
 #session=null;
 constructor({enable=false,provider=pinnedJSON,clock=Date.now}={}){this.enable=enable===true;this.provider=provider;this.clock=clock;this.abort=new AbortController();this.busy=false;this.generation=0;}
 headers(){return {'Content-Type':'application/json','AuthorizationType':'ilink_bot_token','X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),'iLink-App-Id':'bot','iLink-App-ClientVersion':String((2<<16)|(4<<8)|9)};}
 async start(consent){if(!this.enable||!consent||Object.keys(consent).sort().join(',')!=='persist,receive,send'||consent.persist!==true||consent.receive!==true||typeof consent.send!=='boolean')throw new Error('explicit_enrollment_consent_required');if(this.busy||this.#session)throw new Error('enrollment_busy');this.busy=true;const generation=this.generation,started=this.clock();
  try{const r=await this.provider('https://'+API_HOST+'/ilink/bot/get_bot_qrcode?bot_type=3',{method:'POST',headers:this.headers(),body:JSON.stringify({local_token_list:[]}),signal:this.abort.signal});if(this.abort.signal.aborted||this.generation!==generation||this.clock()<started||this.clock()-started>=300000)throw 0;if(!clean(r.qrcode)||!clean(r.qrcode_img_content,4096))throw 0;this.#session={id:randomBytes(24).toString('hex'),started,qrcode:r.qrcode,display:r.qrcode_img_content,state:'wait',consent:{...consent},candidate:null};return this.status();}catch{throw new Error('enrollment_start_rejected');}finally{this.busy=false;}}
 status(){const s=this.#session;if(!s||this.clock()<s.started||this.clock()-s.started>=300000||this.abort.signal.aborted){this.#session=null;return {state:'expired'};}return {session_id:s.id,state:s.state,expires_at_ms:s.started+300000,...(s.state==='confirmed'?{bot_id:s.candidate.botId,owner_peer_id:s.candidate.ownerPeerId}:{})};}
 qrContent(session){const s=this.#session;if(this.status().state==='expired'||s?.id!==session||s.state==='confirmed')throw new Error('enrollment_expired');return s.display;}
 async poll(session,verifyCode){const s=this.#session;if(this.status().state==='expired'||s?.id!==session||this.busy)throw new Error('enrollment_expired_or_busy');if(s.state==='confirmed')return this.status();if(verifyCode!==undefined&&(!/^\d{1,12}$/.test(verifyCode)||s.state!=='need_verifycode'))throw new Error('verification_rejected');this.busy=true;const generation=this.generation;
  try{const target=new URL('https://'+API_HOST+'/ilink/bot/get_qrcode_status');target.searchParams.set('qrcode',s.qrcode);if(verifyCode)target.searchParams.set('verify_code',verifyCode);const r=await this.provider(target.href,{method:'GET',headers:{'iLink-App-Id':'bot','iLink-App-ClientVersion':String((2<<16)|(4<<8)|9)},signal:this.abort.signal});if(this.#session!==s||this.status().state==='expired'||generation!==this.generation)throw 0;
   if(['wait','scaned','need_verifycode'].includes(r.status)){s.state=r.status;return this.status();}
   if(r.status==='scaned_but_redirect'){if(r.redirect_host!==API_HOST)throw 0;s.state='wait';return this.status();}
   if(r.status!=='confirmed'||!clean(r.bot_token,4096)||!clean(r.ilink_bot_id)||!clean(r.ilink_user_id))throw 0;
   const base=apiBase(r.baseurl||'https://'+API_HOST,[API_HOST]);s.candidate={botToken:r.bot_token,botId:r.ilink_bot_id,ownerPeerId:r.ilink_user_id,apiBase:base,boundAtMs:this.clock(),consent:s.consent};s.state='confirmed';return this.status();
  }catch{this.#session=null;throw new Error('enrollment_poll_rejected');}finally{this.busy=false;}}
 confirm(session,{ownerPeerId,botId,confirmOwner=false}={}){const s=this.#session;if(this.status().state!=='confirmed'||s?.id!==session||confirmOwner!==true||ownerPeerId!==s.candidate.ownerPeerId||botId!==s.candidate.botId)throw new Error('owner_confirmation_required');const result=structuredClone(s.candidate);this.#session=null;return result;}
 cancel(){this.generation++;this.abort.abort();this.#session=null;}
}
