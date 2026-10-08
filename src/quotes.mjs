export const INBOUND_QUOTE_POLICY='inbound-ref-v1';
const record=v=>v&&typeof v==='object'&&!Array.isArray(v);
export function quoteSnippet(value,max){
 if(typeof value!=='string')return {text:null,truncated:false};
 const clean=value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');let size=0,out='';
 for(const c of clean){const n=Buffer.byteLength(c);if(size+n>max)return {text:out||null,truncated:true};out+=c;size+=n;}
 return {text:out||null,truncated:clean!==value};
}
const reference=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v)&&v!=='0'?v:null;
// Called only after the original sender/bot/direct/finished/ID/window/context
// checks. Inline quote content is data, never identity, instructions or access.
export function captureInboundQuote(item){
 const ref=item?.ref_msg;if(ref===undefined||ref===null)return {status:'none',quote:null};
 if(!record(ref))return {status:'invalid',quote:null};
 const original=record(ref.message_item)?ref.message_item:null;
 const kind=(typeof original?.type==='number'?({1:'text',2:'image',3:'voice',4:'file',5:'video'})[original.type]:undefined)??'unknown';
 const body=quoteSnippet(kind==='text'?original?.text_item?.text:undefined,4096),title=quoteSnippet(ref.title,512);
 const id=reference(ref.svr_id)??reference(original?.msg_id);
 const quote={trust:'untrusted',source:'current_message_ref_msg',reference_id:id,message_type:kind,text:body.text,title:title.text,
  content_status:body.text?'inline_text':kind!=='text'&&kind!=='unknown'?'media_metadata_only':id&&!title.text?'reference_only':'metadata_only',
  truncated:body.truncated||title.truncated,pixels_available:false,history_lookup_performed:false};
 // Never retain media URLs, AES keys, sender/author, nested ref_msg, context,
 // partial_text lookup hints or arbitrary object fields.
 return {status:'captured',quote};
}
