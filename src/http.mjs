import {MCP_BODY_LIMIT} from './features.mjs';
import {BridgeError,object,readBounded} from './security.mjs';
const json=(status,value,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
export function handler(bridge){
  const resource=new URL(bridge.auth.resource),metadata=new URL('/.well-known/oauth-protected-resource'+resource.pathname,resource.origin).href;
  return async request=>{
    const url=new URL(request.url);if(url.origin!==resource.origin)return json(404,{error:'not_found'});
    if(url.href===metadata&&request.method==='GET'&&bridge.auth.metadata)return json(200,bridge.auth.metadata);
    if(url.pathname==='/healthz'&&request.method==='GET')return json(200,{ok:true,mode:bridge.mode});
    if(url.pathname!==resource.pathname||url.search)return json(404,{error:'not_found'});
    if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST'}});
    if(request.headers.has('Cookie')||request.headers.has('Origin')&&request.headers.get('Origin')!==resource.origin)return json(403,{error:'origin_rejected'});
    let identity;try{identity=bridge.auth.verify(request);if(identity.ownerHash!==bridge.a.ownerHash)throw 0;}catch{return json(401,{error:'not_authorized'},bridge.auth.metadata?{'WWW-Authenticate':'Bearer resource_metadata="'+metadata+'"'}:{});}
    const mediaType=request.headers.get('Content-Type')?.split(';',1)[0].trim().toLowerCase();
    if(mediaType!=='application/json')return json(415,{error:'application_json_required'});
    let id=null;try{
      const p=JSON.parse(await readBounded(request,MCP_BODY_LIMIT));
      if(!p||Array.isArray(p)||p.jsonrpc!=='2.0'||typeof p.method!=='string'||Object.keys(p).some(k=>!['jsonrpc','method','params','id'].includes(k)))throw new BridgeError('invalid_request',-32600);
      id=p.id??null;if(p.id!==undefined&&!(typeof p.id==='string'||typeof p.id==='number'&&Number.isFinite(p.id)))throw new BridgeError('invalid_request',-32600);
      const args={...object(p.params??{},[],Object.keys(p.params??{}))};delete args._meta;
      if(p.id===undefined){if(['notifications/initialized','notifications/cancelled'].includes(p.method))return new Response(null,{status:202});throw new BridgeError('invalid_request',-32600);}
      try{const current=bridge.auth.verify(request);if(current.ownerHash!==identity.ownerHash||current.expires<=bridge.a.clock())throw 0;}catch{throw new BridgeError('not_authorized',-32001);}
      bridge.require();let result;
      if(p.method==='initialize'){
        if(!['2026-07-28','2025-11-25','2025-06-18','2025-03-26','2024-11-05'].includes(args.protocolVersion))throw new BridgeError('unsupported_protocol_version');
        result={protocolVersion:args.protocolVersion,capabilities:{tools:{},events:{}},serverInfo:{name:'weixin-mcp-bridge',version:'0.2.0'}};
      }else if(p.method==='server/discover')result={resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{},events:{}}};
      else if(p.method==='tools/list'){object(args,[]);result={tools:bridge.definitions().tools};}
      else if(p.method==='events/list'){object(args,[],['cursor']);if(args.cursor!=null)throw new BridgeError('invalid_cursor');result={events:[bridge.definitions().event]};}
      else if(p.method==='ping'){object(args,[]);result={};}
      else result=await bridge.call(p.method,args);
      // This fences response exposure, not retroactive cancellation of a send
      // already authorized at request start. Sending claims remain durable.
      try{const fresh=bridge.auth.verify(request);if(fresh.ownerHash!==identity.ownerHash||fresh.expires<=bridge.a.clock())throw 0;}catch{throw new BridgeError('not_authorized',-32001);}
      return json(200,{jsonrpc:'2.0',id,result});
    }catch(e){const known=e instanceof BridgeError,reason=known?e.reason:'operation_failed';return json(reason==='payload_too_large'?413:reason==='not_authorized'?403:200,{jsonrpc:'2.0',id,error:{code:known?e.code:-32603,message:'Request rejected',data:{reason}}});}
  };
}
