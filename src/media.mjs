import {validateJPEG} from './outbound-jpeg.mjs';
import dns from 'node:dns/promises';
import https from 'node:https';
import {createDecipheriv,createCipheriv,createHash,randomBytes} from 'node:crypto';
import {inflateSync,deflateSync} from 'node:zlib';
import {publicAddress} from './pinned-https.mjs';

export const IMAGE_HOST='novac2c.cdn.weixin.qq.com';
export const IMAGE_LIMIT=4*1024*1024;
export const IMAGE_PLACEHOLDER='[微信图片：请用 get_message 读取图片内容]';
const fail=()=>{throw new Error('image_rejected');};
const VALIDATED_BYTES=Symbol('validated-image-bytes');
// Only Tencent's documented CDN download route. No caller-provided host,
// credentials, redirect, arbitrary path, header, or bot token reaches the CDN.
export function imageURLPolicy(value){
 if(value===undefined||value===null)return 'absent';if(value==='')return 'empty';if(typeof value!=='string')return 'invalid_type';
 if(value.length>4096)return 'oversized';if(/[\x00-\x20\\]/.test(value))return 'controls';let u;try{u=new URL(value);}catch{return 'invalid_url';}
 if(u.protocol!=='https:')return 'scheme';if(u.hostname!==IMAGE_HOST)return 'host';if(u.username||u.password)return 'credentials';
 if(u.port||value.startsWith('https://'+IMAGE_HOST+':'))return 'port';if(u.hash)return 'fragment';if(u.pathname!=='/c2c/download')return 'path';
 if([...u.searchParams.keys()].some(k=>k!=='encrypted_query_param')||u.searchParams.getAll('encrypted_query_param').length!==1)return 'query_fields';
 const q=u.searchParams.get('encrypted_query_param');if(!q||q.length>2048||/[\x00-\x1f]/.test(q))return 'query_bounds';
 if(!value.startsWith('https://'+IMAGE_HOST+'/c2c/download?'))return 'noncanonical';return 'allowed';
}
export function imageURL(value){
 if(imageURLPolicy(value)!=='allowed')fail();return new URL(value).href;
}
function aesKey(value,hex=false){
 if(typeof value!=='string')fail();
 if(hex){if(!/^[a-fA-F0-9]{32}$/.test(value))fail();return value.toLowerCase();}
 if(!value||value.length>64||! /^[A-Za-z0-9+/_-]+={0,2}$/.test(value))fail();
 const normalized=value.replaceAll('-','+').replaceAll('_','/'),unpadded=normalized.replace(/=+$/,'');
 const b=Buffer.from(normalized,'base64');if(b.toString('base64').replace(/=+$/,'')!==unpadded||(normalized.includes('=')&&b.toString('base64')!==normalized))fail();
 if(b.length===16)return b.toString('hex');
 if(b.length===32&&/^[a-fA-F0-9]{32}$/.test(b.toString('ascii')))return b.toString('ascii').toLowerCase();fail();
}
export function imageMetadata(item){
 const reject=stage=>{const e=new Error('image_rejected');e.code='image_'+stage;throw e;};
 if(item?.type!==2||!item.image_item||typeof item.image_item!=='object')reject('item_rejected');
 const i=item.image_item,m=i.media;if(!m||typeof m!=='object'||Array.isArray(m))reject('media_missing');
 if(m.encrypt_type!==undefined&&m.encrypt_type!==null&&m.encrypt_type!==0&&m.encrypt_type!==1)reject('encrypt_type_rejected');
 // Prefer Tencent's documented canonical query route when provided. A full
 // URL can contain a different representation; it must not veto the available
 // fixed-host route or select an arbitrary destination. Never fetch both.
 let url;if(m.encrypt_query_param!==undefined&&m.encrypt_query_param!==null&&m.encrypt_query_param!==''){
  const q=m.encrypt_query_param;if(typeof q!=='string'||q.length>2048||/[\x00-\x1f]/.test(q))reject('query_rejected');try{const target=new URL('https://'+IMAGE_HOST+'/c2c/download');target.searchParams.set('encrypted_query_param',q);url=imageURL(target.href);}catch{reject('query_rejected');}
 }else{if(!m.full_url)reject('query_rejected');try{url=imageURL(m.full_url);}catch{reject('url_rejected');}}
 let key;try{key=i.aeskey?aesKey(i.aeskey,true):m.aes_key?aesKey(m.aes_key):null;if([i.aeskey,m.aes_key].some(v=>v!==undefined&&v!==null&&typeof v!=='string'))reject('key_rejected');}catch{reject('key_rejected');}
 // encrypt_type describes encrypted fileid vs packed CDN metadata; it does
 // not indicate whether the downloaded bytes require AES. Tencent chooses
 // decrypt vs plain solely by key presence. Format/size checks still apply.
 return {url,key};
}
export function imageMetadataDiagnostic(item){
 const i=item?.image_item,m=i?.media;
 const shape=v=>v===undefined||v===null?'absent':typeof v!=='string'?'invalid_type':v===''?'empty':v.length>4096?'oversized':'nonempty';
 let reason=null;try{imageMetadata(item);}catch(e){reason=['image_item_rejected','image_media_missing','image_encrypt_type_rejected','image_url_rejected','image_query_rejected','image_key_rejected'].includes(e.code)?e.code:'image_metadata_rejected';}
 return {reason,media_present:!!m&&typeof m==='object'&&!Array.isArray(m),full_url:shape(m?.full_url),query:shape(m?.encrypt_query_param),image_key:shape(i?.aeskey),media_key:shape(m?.aes_key),encrypt_type:m?.encrypt_type===0?0:m?.encrypt_type===1?1:m?.encrypt_type==null?'absent':'other',url_source:reason?'none':m?.encrypt_query_param?'canonical_query':'allowed_full_url',provided_url_policy:imageURLPolicy(m?.full_url)};
}
export async function pinnedImage(value,{signal,timeoutMs=12000,resolver=host=>dns.lookup(host,{all:true,verbatim:true}),request=https.request}={}){
 if(signal?.aborted)throw new Error('image_unavailable');const u=new URL(imageURL(value));let timer;const deadline=Date.now()+timeoutMs;
 let abortDNS;
 const records=await Promise.race([resolver(u.hostname),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('image_unavailable')),timeoutMs);}),new Promise((_,reject)=>{abortDNS=()=>reject(new Error('image_unavailable'));signal?.addEventListener('abort',abortDNS,{once:true});if(signal?.aborted)abortDNS();})]).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abortDNS);});
 if(signal?.aborted||!records?.length||records.some(r=>!publicAddress(r.address)))throw new Error('image_unavailable');const chosen=records[0];
 return new Promise((resolve,reject)=>{
  const rejectSafe=()=>reject(new Error('image_unavailable'));
  const req=request(u,{method:'GET',agent:false,headers:{Accept:'image/png,image/jpeg,application/octet-stream','Accept-Encoding':'identity'},minVersion:'TLSv1.2',rejectUnauthorized:true,servername:u.hostname,lookup:(_h,opt,cb)=>opt?.all?cb(null,[chosen]):cb(null,chosen.address,chosen.family)},res=>{
   const length=res.headers?.['content-length'],type=res.headers?.['content-type']?.split(';')[0]?.trim()?.toLowerCase();
   if(res.statusCode!==200||(type&&!['image/png','image/jpeg','application/octet-stream'].includes(type))||(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>IMAGE_LIMIT+16))||(res.headers?.['content-encoding']&&res.headers['content-encoding']!=='identity')){res.resume();req.destroy();rejectSafe();return;}
   let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>IMAGE_LIMIT+16){req.destroy();rejectSafe();return;}chunks.push(chunk);});
   res.on('error',rejectSafe);res.on('aborted',rejectSafe);res.on('end',()=>{if(length!==undefined&&Number(length)!==size){rejectSafe();return;}resolve(Buffer.concat(chunks));});
  });
  const abort=()=>req.destroy(new Error('cancelled')),stop=setTimeout(()=>req.destroy(new Error('timeout')),Math.max(1,deadline-Date.now()));
  signal?.addEventListener('abort',abort,{once:true});req.on('close',()=>{clearTimeout(stop);signal?.removeEventListener('abort',abort);});req.on('error',rejectSafe);if(signal?.aborted)abort();else req.end();
 });
}
function dimensions(width,height){if(width<1||height<1||width>8192||height>8192||width*height>8*1024*1024)fail();return {width,height};}
function crc(b){let c=0xffffffff;for(const v of b){c^=v;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
export function inspectImage(b){
 if(!Buffer.isBuffer(b)||!b.length||b.length>IMAGE_LIMIT)fail();
 if(b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))){
  let at=8,header=false,end=false,parts=[],dims,channels;
  while(at+12<=b.length){const n=b.readUInt32BE(at);if(n>b.length-at-12)fail();const type=b.toString('ascii',at+4,at+8),payload=b.subarray(at+8,at+8+n);
   if(crc(b.subarray(at+4,at+8+n))!==b.readUInt32BE(at+8+n))fail();
   if(!header&&type!=='IHDR')fail();
   if(type==='IHDR'){if(header||n!==13||payload[8]!==8||payload[10]!==0||payload[11]!==0||payload[12]!==0)fail();channels=({0:1,2:3,4:2,6:4})[payload[9]];if(!channels)fail();dims=dimensions(payload.readUInt32BE(0),payload.readUInt32BE(4));header=true;}
   else if(type==='IDAT')parts.push(payload);
   else if(type==='IEND'){if(n!==0||!parts.length||at+12!==b.length)fail();end=true;break;}
   else if(type==='acTL'||type==='fcTL'||type==='fdAT'||(type[0]===type[0].toUpperCase()&&type!=='PLTE'))fail();
   at+=n+12;
  }
  if(!end)fail();const row=dims.width*channels+1,expected=row*dims.height;let raw;try{raw=inflateSync(Buffer.concat(parts),{maxOutputLength:expected});}catch{fail();}
  if(raw.length!==expected)fail();for(let n=0;n<raw.length;n+=row)if(raw[n]>4)fail();return {mime_type:'image/png',...dims};
 }
 if(b.length>=4&&b[0]===255&&b[1]===216){
  let at=2,dims,scan=false,end=false,eoi=0;
  while(at<b.length){if(b[at++]!==255)fail();while(b[at]===255)at++;const marker=b[at++];
   // Tencent JPEGs may append auxiliary bytes after EOI. Validate the image
   // structure through its first EOI, then return only that validated prefix.
   // The complete downloaded/plain buffer still obeys the original size cap.
   if(marker===217){if(!scan||!dims)fail();end=true;eoi=at;break;}
   if(marker===216||marker===0||marker===1||(marker>=208&&marker<=215)||at+2>b.length)fail();
   const n=b.readUInt16BE(at);if(n<2||at+n>b.length)fail();
   if([192,193,194].includes(marker)){if(dims||n<8||b[at+2]!==8)fail();dims=dimensions(b.readUInt16BE(at+5),b.readUInt16BE(at+3));const components=b[at+7];if(![1,3,4].includes(components)||n!==8+3*components)fail();}
   else if(marker>=195&&marker<=207&&![196,200,204].includes(marker))fail();
   at+=n;
   if(marker===218){if(!dims)fail();scan=true;while(at<b.length){if(b[at]!==255){at++;continue;}if(b[at+1]===0||(b[at+1]>=208&&b[at+1]<=215)){at+=2;continue;}break;}}
  }
  if(!end)fail();return {mime_type:'image/jpeg',...dims,[VALIDATED_BYTES]:eoi};
 }
 fail();
}
export function decryptImage(bytes,key){
 if(!Buffer.isBuffer(bytes)||bytes.length>IMAGE_LIMIT+16)fail();let plain=bytes;
 if(key!==null){if(!/^[a-f0-9]{32}$/.test(key)||!bytes.length||bytes.length%16)fail();try{const c=createDecipheriv('aes-128-ecb',Buffer.from(key,'hex'),null);plain=Buffer.concat([c.update(bytes),c.final()]);}catch{fail();}}
 const info=inspectImage(plain);if(info[VALIDATED_BYTES])plain=plain.subarray(0,info[VALIDATED_BYTES]);
 return {data:plain.toString('base64'),mime_type:info.mime_type,width:info.width,height:info.height};
}
// Fixed public test pixels only. Pure read: no inbound message, event, claim,
// CDN request, credential, attachment upload, or durable image storage.
export function imageFixture(){
 const width=64,height=64,raw=Buffer.alloc(height*(width*3+1));for(let y=0;y<height;y++)for(let x=0;x<width;x++){const c=((x>>3)+(y>>3))%2?[228,55,139]:[36,174,116];raw.set(c,y*(width*3+1)+1+x*3);}
 const chunk=(type,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b;};
 const h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=8;h[9]=2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

// A tool receives bytes, never a caller-selected download URL or local path.
export function outboundImage(value){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!=='data,mime_type'||!['image/png','image/jpeg'].includes(value.mime_type)||typeof value.data!=='string'||!value.data||value.data.length>Math.ceil(IMAGE_LIMIT/3)*4||! /^[A-Za-z0-9+/]+={0,2}$/.test(value.data))fail();
 const bytes=Buffer.from(value.data,'base64');if(bytes.toString('base64')!==value.data)fail();const image=decryptImage(bytes,null);if(image.mime_type!==value.mime_type)fail();if(image.mime_type==='image/jpeg')validateJPEG(bytes);return {bytes:Buffer.from(image.data,'base64'),mime_type:image.mime_type,width:image.width,height:image.height};
}
export function uploadURL(value,filekey){
 if(typeof value!=='string'||value.length>8192||/[\x00-\x20\\]/.test(value))fail();const u=new URL(value);
 if(u.protocol!=='https:'||u.hostname!==IMAGE_HOST||u.port||u.username||u.password||u.hash||u.pathname!=='/c2c/upload'||!value.startsWith('https://'+IMAGE_HOST+'/c2c/upload?'))fail();
 if([...u.searchParams.keys()].some(k=>!['encrypted_query_param','filekey'].includes(k))||u.searchParams.getAll('encrypted_query_param').length!==1||u.searchParams.getAll('filekey').length!==1||u.searchParams.get('filekey')!==filekey)fail();
 const q=u.searchParams.get('encrypted_query_param');if(!q||q.length>4096||/[\x00-\x1f]/.test(q))fail();return u;
}
export async function pinnedUpload(value,bytes,{filekey,signal,timeoutMs=12000,resolver=host=>dns.lookup(host,{all:true,verbatim:true}),request=https.request}={}){
 if(signal?.aborted)throw new Error('image_upload_unavailable');const u=uploadURL(value,filekey);if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>IMAGE_LIMIT+16||bytes.length%16)fail();
 let timer,abortDNS;const deadline=Date.now()+timeoutMs;
 const addresses=await Promise.race([resolver(u.hostname),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('image_upload_unavailable')),timeoutMs);}),new Promise((_,reject)=>{abortDNS=()=>reject(new Error('image_upload_unavailable'));signal?.addEventListener('abort',abortDNS,{once:true});if(signal?.aborted)abortDNS();})]).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abortDNS);});
 if(signal?.aborted||!Array.isArray(addresses)||!addresses.length||addresses.some(x=>!publicAddress(x.address))||Date.now()>=deadline)throw new Error('image_upload_unavailable');const chosen=addresses[0];
 return new Promise((resolve,reject)=>{
  const bad=()=>reject(new Error('image_upload_unavailable'));
  const req=request(u,{method:'POST',agent:false,headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length),'Accept-Encoding':'identity'},minVersion:'TLSv1.2',rejectUnauthorized:true,servername:u.hostname,lookup:(_host,o,done)=>o?.all?done(null,[chosen]):done(null,chosen.address,chosen.family)},res=>{
   const length=res.headers?.['content-length'];if(res.statusCode!==200||(res.headers?.['content-encoding']&&res.headers['content-encoding']!=='identity')||(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>4096))){res.resume();req.destroy();bad();return;}const q=res.headers?.['x-encrypted-param'];if(typeof q!=='string'||!q||q.length>4096||/[\x00-\x1f]/.test(q)){res.resume();req.destroy();bad();return;}
   let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>4096){req.destroy();bad();}});res.on('error',bad);res.on('aborted',bad);res.on('end',()=>resolve(q));
  });
  const stop=setTimeout(()=>req.destroy(new Error('timeout')),Math.max(1,deadline-Date.now())),abort=()=>req.destroy(new Error('cancelled'));signal?.addEventListener('abort',abort,{once:true});req.on('close',()=>{clearTimeout(stop);signal?.removeEventListener('abort',abort);});req.on('error',bad);if(signal?.aborted)abort();else req.end(bytes);
 });
}
// This pipeline is called only AFTER the durable final claim. It performs each
// upload step once. A failed or interrupted step never makes that claim ready.
export async function uploadImage({bytes,peer,api,upload=pinnedUpload,signal,current}){
 const key=randomBytes(16),filekey=randomBytes(16).toString('hex'),cipher=createCipheriv('aes-128-ecb',key,null),encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
 try{
  if(!current())throw 0;
  const r=await api('/ilink/bot/getuploadurl',{filekey,media_type:1,to_user_id:peer,rawsize:bytes.length,rawfilemd5:createHash('md5').update(bytes).digest('hex'),filesize:encrypted.length,no_need_thumb:true,aeskey:key.toString('hex')});
  if(!current()||(r.ret!==undefined&&r.ret!==0)||(r.errcode!==undefined&&r.errcode!==0))throw 0;
  let value;if(typeof r.upload_full_url==='string'&&r.upload_full_url)value=r.upload_full_url;else if(typeof r.upload_param==='string'&&r.upload_param){const target=new URL('https://'+IMAGE_HOST+'/c2c/upload');target.searchParams.set('encrypted_query_param',r.upload_param);target.searchParams.set('filekey',filekey);value=target.href;}else throw 0;
  uploadURL(value,filekey);const q=await upload(value,encrypted,{filekey,signal});if(!current()||typeof q!=='string'||!q||q.length>4096||/[\x00-\x1f]/.test(q))throw 0;
  return {type:2,image_item:{media:{encrypt_query_param:q,aes_key:Buffer.from(key.toString('hex'),'ascii').toString('base64'),encrypt_type:1},mid_size:encrypted.length}};
 }catch{throw new Error('image_upload_unavailable');}finally{key.fill(0);encrypted.fill(0);}
}
