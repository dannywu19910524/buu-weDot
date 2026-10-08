import fs from 'node:fs';
import {readConfig} from '../src/config.mjs';
import {MessageStore} from '../src/store.mjs';
let adapter;
try{
  const i=process.argv.indexOf('--config');if(i<0||!process.argv.includes('--confirm-revoke'))throw 0;
  const {config:c,auth,key,binding,clientVersion}=readConfig(process.argv[i+1]);
  if(!fs.existsSync(c.state.database))throw new Error('existing_state_required');
  adapter=new MessageStore({mode:c.mode,enableReal:c.real?.enable===true,binding,dbPath:c.state.database,key,ownerHash:auth.ownerHash,clientVersion});key.fill(0);
  adapter.revoke();if(adapter.db.prepare("SELECT 1 FROM sqlite_master WHERE name='mcp_subscription'").get())adapter.db.exec('DELETE FROM mcp_subscription');
  console.log(JSON.stringify({revoked:true,claims_retained:true,network_calls:0}));
}catch{console.error('Revocation rejected; stop the writer and pass --config PRIVATE_CONFIG --confirm-revoke.');process.exitCode=1;}finally{await adapter?.close();}
