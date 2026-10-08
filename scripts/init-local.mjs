import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {isMain} from '../src/private-files.mjs';
export function initLocal(directory='.local'){
  const dir=path.resolve(directory);if(fs.existsSync(dir))throw new Error('new_private_directory_required');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.mkdirSync(path.join(dir,'secrets'),{mode:0o700});fs.mkdirSync(path.join(dir,'state'),{mode:0o700});
  const config=JSON.parse(fs.readFileSync(new URL('../examples/mock.config.example.json',import.meta.url),'utf8'));
  fs.writeFileSync(path.join(dir,'secrets','local-token'),randomBytes(32).toString('base64url'),{mode:0o600,flag:'wx'});
  fs.writeFileSync(path.join(dir,'secrets','state-key'),randomBytes(32).toString('base64'),{mode:0o600,flag:'wx'});
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
  return {created:true,mode:'mock',provider_access_configured:false};
}
if(isMain(import.meta.url)){try{const i=process.argv.indexOf('--directory');console.log(JSON.stringify(initLocal(i>=0?process.argv[i+1]:'.local')));}catch{console.error('Local initialization rejected; use a new private directory.');process.exitCode=1;}}
