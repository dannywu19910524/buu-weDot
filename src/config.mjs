import path from 'node:path';
import {createHash,timingSafeEqual} from 'node:crypto';
import {privateFile} from './private-files.mjs';
import {ownerVerifier} from './auth.mjs';
import {featureConfig} from './features.mjs';
import {object} from './security.mjs';
export function readConfig(file){
  file=path.resolve(file);const base=path.dirname(file),c=JSON.parse(privateFile(file));
  object(c,['version','resource','listen','owner','auth','state','callbackHosts'],['mode','real','features']);if(c.version!==1)throw new Error('config_version_unsupported');
  c.features=featureConfig(c.features);c.mode??='mock';if(!['mock','real'].includes(c.mode))throw new Error('invalid_mode');object(c.listen,['host','port']);object(c.owner,['canonicalId']);object(c.state,['database','keyFile']);
  if(!['127.0.0.1','::1'].includes(c.listen.host)||!Number.isInteger(c.listen.port)||c.listen.port<1||c.listen.port>65535||typeof c.owner.canonicalId!=='string'||!c.owner.canonicalId||c.owner.canonicalId.length>256||!Array.isArray(c.callbackHosts)||c.callbackHosts.some(h=>typeof h!=='string'||!/^[a-z0-9.-]+\.[a-z]+$/.test(h)))throw new Error('configuration_required');
  const resource=new URL(c.resource);if(resource.username||resource.password||resource.search||resource.hash||resource.pathname!=='/mcp')throw new Error('invalid_resource');
  const resolve=p=>{if(typeof p!=='string'||!p)throw new Error('invalid_private_path');return path.resolve(base,p);};
  c.state.database=resolve(c.state.database);c.state.keyFile=resolve(c.state.keyFile);const key=Buffer.from(privateFile(c.state.keyFile),'base64');if(key.length!==32)throw new Error('state_key_required');
  const ownerHash=createHash('sha256').update(c.owner.canonicalId).digest('hex');let auth;
  if(c.auth.mode==='local-bearer'){
    object(c.auth,['mode','tokenFile']);if(c.mode!=='mock'||resource.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(resource.hostname)||Number(resource.port)!==c.listen.port)throw new Error('local_auth_mock_loopback_only');
    c.auth.tokenFile=resolve(c.auth.tokenFile);const token=privateFile(c.auth.tokenFile);if(!/^[A-Za-z0-9_-]{43,128}$/.test(token)||/REPLACE|CHANGEME/.test(token))throw new Error('local_token_required');
    auth={canonicalOwner:c.owner.canonicalId,ownerHash,resource:c.resource,verify(request){const actual=Buffer.from(request.headers.get('Authorization')??''),expected=Buffer.from('Bearer '+token);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error('not_authorized');return {ownerHash,canonicalOwner:c.owner.canonicalId,expires:Infinity};}};
  }else if(c.auth.mode==='jwt'){
    object(c.auth,['mode','issuer','subject','jwksFile'],['requiredScope']);if(resource.protocol!=='https:')throw new Error('https_resource_required');
    c.auth.jwksFile=resolve(c.auth.jwksFile);const jwks=JSON.parse(privateFile(c.auth.jwksFile));auth=ownerVerifier({issuer:c.auth.issuer,resource:c.resource,subject:c.auth.subject,canonicalOwner:c.owner.canonicalId,requiredScope:c.auth.requiredScope??'weixin:owner',jwks:jwks.keys});
  }else throw new Error('auth_configuration_required');
  let binding,clientVersion='2.4.9';if(c.mode==='real'){object(c.real,['enable','bindingFile'],['clientVersion']);if(c.real.enable!==true)throw new Error('real_mode_requires_explicit_enable');c.real.bindingFile=resolve(c.real.bindingFile);binding=JSON.parse(privateFile(c.real.bindingFile));clientVersion=c.real.clientVersion??clientVersion;}
  return {config:c,auth,key,binding,clientVersion};
}
