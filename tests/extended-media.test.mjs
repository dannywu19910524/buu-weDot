import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {fixture} from './fixture.mjs';
import {imageFixture,decryptImage,outboundImage,imageMetadata,imageURL,uploadURL,IMAGE_LIMIT} from '../src/media.mjs';
import {jpegFixture} from './image-fixtures.mjs';
const imageInput=()=>({mime_type:'image/png',data:imageFixture().toString('base64')});
const imageItem=()=>({type:2,image_item:{media:{encrypt_query_param:'REPLACE_WITH_DOWNLOAD_PARAMETER'}}});
const first=f=>f.a.db.prepare('SELECT id FROM messages ORDER BY created,id LIMIT 1').get().id;
test('mock image event, native image read and image final never invoke supplied real transports',async t=>{
 let mediaCalls=0;const f=fixture({features:{outboundImages:true},imageDownload:async()=>{mediaCalls++;throw 0;},imageUpload:async()=>{mediaCalls++;throw 0;}});t.after(f.close);await f.start();await f.subscribe();const m=await f.inject('image','image','image'),args={binding_id:'mock-binding',message_id:m.message_id};
 const read=(await f.call('get_message',args)).result;assert.equal(read.structuredContent.message_kind,'image');assert.equal(read.content[1].type,'image');assert.deepEqual(Buffer.from(read.content[1].data,'base64'),imageFixture());assert.equal(read.structuredContent.image_status,'available');
 const reply=await f.call('reply_weixin_image',{...args,image:imageInput()});assert.equal(reply.result.structuredContent.sent,false);assert.equal(reply.result.structuredContent.response_kind,'image');assert.equal((await f.call('reply_weixin_image',{...args,image:imageInput()})).result.structuredContent.duplicate,true);assert.ok((await f.call('reply_weixin',{...args,text:'second final'})).error);assert.equal(mediaCalls,0);assert.equal(f.providerCalls.length,0);
});
test('real image metadata is bound and encrypted; get exposes pixels without CDN parameters or AES key',async t=>{
 const key=randomBytes(16),plain=imageFixture(),c=createCipheriv('aes-128-ecb',key,null),encrypted=Buffer.concat([c.update(plain),c.final()]);let downloads=0;
 const f=fixture({mode:'real',imageDownload:async(url)=>{downloads++;assert.match(url,/^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/download\?/);return encrypted;}});t.after(f.close);await f.start();await f.subscribe();const item=imageItem();item.image_item.aeskey=key.toString('hex');await f.receive([f.wire('2',{item_list:[item]}),f.wire('3',{from_user_id:'foreign',item_list:[item]})]);
 const result=(await f.call('get_message',{binding_id:'real-binding',message_id:first(f)})).result;assert.equal(result.structuredContent.image_status,'available');assert.equal(downloads,1);assert.deepEqual(Buffer.from(result.content[1].data,'base64'),plain);const metadata=JSON.stringify(result.structuredContent);assert.ok(!metadata.includes(key.toString('hex'))&&!metadata.includes('encrypted_query_param'));
});
for(const change of ['expiry','revoke'])test('late image read rejects the entire result after '+change,async t=>{
 let finish,entered;const started=new Promise(r=>entered=r),f=fixture({mode:'real',imageDownload:()=>{entered();return new Promise(r=>finish=r);}});t.after(f.close);await f.start();await f.subscribe();await f.receive([f.wire('1',{item_list:[imageItem()]})]);const read=f.call('get_message',{binding_id:'real-binding',message_id:first(f)});await started;if(change==='expiry')f.advance(3600000);else f.a.revoke();finish(imageFixture());assert.ok((await read).error);
});
test('combined reads map image blocks to each independently verified message without claiming',async t=>{
 const f=fixture();t.after(f.close);await f.start();await f.subscribe();await f.inject('one','one','image');f.advance(1);await f.inject('two','two');f.advance(1);await f.inject('three','three','image');
 const r=(await f.call('read_pending_weixin',{binding_id:'mock-binding',limit:3})).result;assert.equal(r.content.length,3);assert.equal(r.structuredContent.messages.length,3);assert.deepEqual(r.structuredContent.messages.map(x=>x.native_image_content_indexes),[[1],[],[2]]);assert.equal(r.structuredContent.claim_performed,false);assert.ok(r.structuredContent.messages.every(x=>x.replyable));
});
test('last asynchronous download cannot expose an earlier expired batch member',async t=>{
 let n=0;const f=fixture({mode:'real',imageDownload:async()=>{if(++n===2)f.advance(3600000);return imageFixture();}});t.after(f.close);await f.start();await f.subscribe();await f.receive([f.wire('1',{item_list:[imageItem()]}),f.wire('2',{item_list:[imageItem()]})]);assert.ok((await f.call('read_pending_weixin',{binding_id:'real-binding'})).error);
});
test('image final uses one claimed upload/send pipeline, fixed owner and AES hex-ascii base64',async t=>{
 let uploaded,uploadCount=0;const f=fixture({mode:'real',features:{outboundImages:true},imageUpload:async(url,bytes,{filekey})=>{uploadCount++;assert.equal(uploadURL(url,filekey).hostname,'novac2c.cdn.weixin.qq.com');uploaded=Buffer.from(bytes);return 'REPLACE_WITH_DOWNLOAD_PARAMETER';}});t.after(f.close);await f.start();await f.subscribe();await f.receive([f.wire()]);const id=first(f),args={binding_id:'real-binding',message_id:id,image:imageInput()};
 const r=(await f.call('reply_weixin_image',args)).result.structuredContent;assert.equal(r.sent,true);assert.equal(r.response_kind,'image');assert.equal(uploadCount,1);const allocation=f.providerCalls.find(x=>x.url.endsWith('/getuploadurl')),send=f.providerCalls.find(x=>x.url.endsWith('/sendmessage')),item=send.body.msg.item_list[0];assert.equal(allocation.body.media_type,1);assert.equal(allocation.body.to_user_id,f.binding.ownerPeerId);assert.equal(send.body.msg.to_user_id,f.binding.ownerPeerId);assert.equal(item.type,2);assert.equal(Buffer.from(item.image_item.media.aes_key,'base64').toString('ascii'),allocation.body.aeskey);
 const dec=createDecipheriv('aes-128-ecb',Buffer.from(allocation.body.aeskey,'hex'),null);assert.deepEqual(Buffer.concat([dec.update(uploaded),dec.final()]),imageFixture());assert.equal(item.image_item.mid_size,uploaded.length);assert.equal((await f.call('reply_weixin_image',args)).result.structuredContent.duplicate,true);assert.equal(uploadCount,1);assert.equal(f.providerCalls.filter(x=>x.url.endsWith('/sendmessage')).length,1);
});
for(const stage of ['upload','send','revoke'])test('image '+stage+' uncertainty retains terminal final claim and never retries',async t=>{
 let uploads=0;const f=fixture({mode:'real',features:{outboundImages:true},imageUpload:async()=>{uploads++;if(stage==='upload')throw new Error('private CDN error');if(stage==='revoke')f.a.revoke();return 'REPLACE_WITH_DOWNLOAD_PARAMETER';},send:async()=>stage==='send'?{}:{ret:0}});t.after(f.close);await f.start();await f.subscribe();await f.receive([f.wire()]);const id=first(f),args={binding_id:'real-binding',message_id:id,image:imageInput()};assert.ok((await f.call('reply_weixin_image',args)).error);assert.equal(f.a.db.prepare('SELECT reply_state FROM ledger WHERE id=?').get(id).reply_state,'uncertain');assert.ok((await f.call('reply_weixin_image',args)).error);assert.equal(uploads,1);if(stage!=='send')assert.equal(f.providerCalls.filter(x=>x.url.endsWith('/sendmessage')).length,0);
});
test('image formats, exact base64, size and fixed destinations are enforced before claim',async t=>{
 const good=imageInput();assert.throws(()=>outboundImage({...good,mime_type:'image/jpeg'}));assert.throws(()=>outboundImage({...good,data:good.data+'\n'}));assert.throws(()=>outboundImage({mime_type:'image/png',data:Buffer.alloc(IMAGE_LIMIT+1).toString('base64')}));assert.throws(()=>decryptImage(Buffer.from('not an image'),null));assert.throws(()=>imageURL('https://foreign.example.com/c2c/download?encrypted_query_param=REPLACE_WITH_PARAMETER'));assert.throws(()=>imageMetadata({type:2,image_item:{media:{full_url:'http://127.0.0.1/'}}}));
 const f=fixture({features:{outboundImages:true}});t.after(f.close);await f.start();await f.subscribe();const m=await f.inject();assert.ok((await f.call('reply_weixin_image',{binding_id:'mock-binding',message_id:m.message_id,image:{...good,mime_type:'image/jpeg'}})).error);assert.equal(f.a.db.prepare('SELECT reply_state FROM ledger').get().reply_state,'ready');
});
test('outbound JPEG requires complete tables and legal scans; a tiny forged JPEG cannot claim a final',async t=>{
 for(const progressive of [false,true])assert.equal(outboundImage({mime_type:'image/jpeg',data:jpegFixture({progressive}).toString('base64')}).width,1);
 const fake=Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,2,0,255,217]);
 for(const bytes of [fake,jpegFixture({omitQuant:true}),jpegFixture({omitHuffman:true}),jpegFixture({emptyScan:true}),Buffer.concat([jpegFixture(),Buffer.from([0])])])assert.throws(()=>outboundImage({mime_type:'image/jpeg',data:bytes.toString('base64')}));
 const progressive=jpegFixture({progressive:true}),firstScan=progressive.indexOf(Buffer.from([255,218])),secondScan=progressive.indexOf(Buffer.from([255,218]),firstScan+2);
 const repeatedDC=Buffer.concat([progressive.subarray(0,secondScan),progressive.subarray(firstScan,secondScan),progressive.subarray(secondScan)]),refineWithoutInitial=Buffer.from(progressive);refineWithoutInitial[secondScan+9]=16;
 for(const bytes of [repeatedDC,refineWithoutInitial])assert.throws(()=>outboundImage({mime_type:'image/jpeg',data:bytes.toString('base64')}));
 const f=fixture({features:{outboundImages:true}});t.after(f.close);await f.start();await f.subscribe();const m=await f.inject();assert.ok((await f.call('reply_weixin_image',{binding_id:'mock-binding',message_id:m.message_id,image:{mime_type:'image/jpeg',data:fake.toString('base64')}})).error);assert.equal(f.a.db.prepare('SELECT reply_state FROM ledger').get().reply_state,'ready');
});
