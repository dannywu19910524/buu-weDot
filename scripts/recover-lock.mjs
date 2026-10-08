import {readConfig} from '../src/config.mjs';
import {recoverLock} from '../src/private-files.mjs';
try{const i=process.argv.indexOf('--config');if(i<0)throw 0;const {config,key}=readConfig(process.argv[i+1]);key.fill(0);console.log(JSON.stringify(recoverLock(config.state.database,{confirmStopped:process.argv.includes('--confirm-stopped')})));}catch{console.error('Lock recovery rejected; the recorded process must be absent and --confirm-stopped is required.');process.exitCode=1;}
