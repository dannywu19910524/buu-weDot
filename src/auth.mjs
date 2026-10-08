import {createPublicKey,verify,createHash} from 'node:crypto';
// Resource-server verifier only. It never mints tokens, follows token-supplied
// key URLs, adopts the first caller, or trusts unverified proxy identity headers.
export function ownerVerifier({issuer,resource,subject,canonicalOwner,jwks,clock=()=>Date.now(),requiredScope='weixin:owner',grantCheck=()=>true}){
  const secure=u=>{const x=new URL(u);if(x.protocol!=='https:'||x.username||x.password||x.hash||x.search)throw 0;return x.href;};
  try{secure(issuer);secure(resource);}catch{throw new Error('auth_configuration_required');}
  if(!subject||!canonicalOwner||canonicalOwner.length>256||!Array.isArray(jwks)||!jwks.length)throw new Error('auth_configuration_required');
  const keys=new Map();
  for(const j of jwks){
    if(!j.kid||keys.has(j.kid)||j.kty!=='RSA'||j.d||j.alg!=='RS256'||j.use!=='sig')throw new Error('auth_configuration_required');
    const key=createPublicKey({key:j,format:'jwk'});
    if(key.asymmetricKeyDetails.modulusLength<2048)throw new Error('auth_configuration_required');
    keys.set(j.kid,key);
  }
  const ownerHash=createHash('sha256').update(canonicalOwner).digest('hex');
  return {
    resource,issuer,ownerHash,canonicalOwner,requiredScope,
    replaceVerificationKeys(next){
      const replacement=new Map();for(const j of next){if(!j.kid||replacement.has(j.kid)||j.kty!=='RSA'||j.d||j.alg!=='RS256'||j.use!=='sig')throw new Error('auth_configuration_required');const key=createPublicKey({key:j,format:'jwk'});if(key.asymmetricKeyDetails.modulusLength<2048)throw new Error('auth_configuration_required');replacement.set(j.kid,key);}if(!replacement.size)throw new Error('auth_configuration_required');keys.clear();for(const [kid,key] of replacement)keys.set(kid,key);
    },
    metadata:{resource,authorization_servers:[issuer],scopes_supported:[requiredScope],bearer_methods_supported:['header']},
    verify(request){
      try{
        const bearer=request.headers.get('authorization');
        if(!bearer||bearer.length>16384||!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer))throw 0;
        const [h,p,s]=bearer.slice(7).split('.'),header=JSON.parse(Buffer.from(h,'base64url')),claims=JSON.parse(Buffer.from(p,'base64url'));
        if(!header||header.alg!=='RS256'||!['at+jwt','JWT'].includes(header.typ)||header.crit||header.jku||header.x5u||!keys.has(header.kid))throw 0;
        if(!verify('RSA-SHA256',Buffer.from(h+'.'+p),keys.get(header.kid),Buffer.from(s,'base64url')))throw 0;
        const now=Math.floor(clock()/1000),aud=claims.aud;
        if(claims.iss!==issuer||claims.sub!==subject||!(aud===resource||Array.isArray(aud)&&aud.length===1&&aud[0]===resource))throw 0;
        if(!Number.isSafeInteger(claims.exp)||!Number.isSafeInteger(claims.iat)||claims.exp<=now||claims.iat>now+30||claims.exp<=claims.iat||claims.exp-claims.iat>600)throw 0;
        if(claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>now))throw 0;
        if(typeof claims.scope!=='string'||!claims.scope.split(' ').includes(requiredScope)||!grantCheck(claims))throw 0;
        return {ownerHash,canonicalOwner,expires:claims.exp*1000,grantId:claims.grant_id};
      }catch{throw new Error('not_authorized');}
    }
  };
}
