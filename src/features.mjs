export const DEFAULT_FEATURES=Object.freeze({inboundImages:true,outboundImages:false,quoteReplies:true,quoteCache:false,processing:false,typing:false,receiptTyping:false,notifications:false,acknowledgements:false,providerStartNotice:false,notificationContextMs:3600000});
export function featureConfig(value={}){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(k=>!Object.hasOwn(DEFAULT_FEATURES,k)))throw new Error('invalid_features');
  const v={...DEFAULT_FEATURES,...value};
  if(Object.entries(v).some(([k,x])=>k!=='notificationContextMs'&&typeof x!=='boolean')||!Number.isSafeInteger(v.notificationContextMs)||v.notificationContextMs<60000||v.notificationContextMs>10800000||v.typing&&!v.processing||v.receiptTyping&&!v.typing)throw new Error('invalid_features');
  return Object.freeze(v);
}
export const MCP_BODY_LIMIT=6*1024*1024;
export const MCP_RESULT_LIMIT=6*1024*1024-8192;
