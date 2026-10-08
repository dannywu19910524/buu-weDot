import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {Enrollment} from '../src/enrollment.mjs';
import {isMain} from '../src/private-files.mjs';

// Never called by install, server startup, test, demo, or an MCP request.
export function enrollmentArguments(args){const allowed=['--run','--allow-send','--directory'],at=args.indexOf('--directory');if(at<0||args.filter(x=>x==='--directory').length!==1||args.filter(x=>x==='--run').length>1||args.filter(x=>x==='--allow-send').length>1||!args[at+1]||args[at+1].startsWith('--')||args.some((x,i)=>!allowed.includes(x)&&i!==at+1))throw new Error('invalid_enrollment_arguments');return {directory:args[at+1],run:args.includes('--run'),allowSend:args.includes('--allow-send')};}
export async function readVerificationCode(input,output,timeoutMs=300000){if(!input.isTTY||typeof input.setRawMode!=='function')throw new Error('private_tty_required');const raw=input.isRaw;output.write('Enter verification code (hidden): ');input.setRawMode(true);input.resume();let listener,timer;
 try{return await new Promise((resolve,reject)=>{let value='';listener=chunk=>{for(const c of chunk.toString('utf8')){if(c==='\u0003'){reject(new Error('cancelled'));return;}if(c==='\r'||c==='\n'){if(/^\d{1,12}$/.test(value))resolve(value);else reject(new Error('invalid_code'));return;}if(c==='\u007f'||c==='\b')value=value.slice(0,-1);else if(/\d/.test(c)&&value.length<12)value+=c;else{reject(new Error('invalid_code'));return;}}};input.on('data',listener);timer=setTimeout(()=>reject(new Error('expired')),Math.max(1,timeoutMs));});}finally{clearTimeout(timer);input.removeListener('data',listener);input.setRawMode(raw);output.write('\n');}
}
export async function enrollLocal({directory,run=false,allowSend=false,input=process.stdin,output=process.stdout,enrollment,ask,secretPrompt}={}){
 if(!run||!input.isTTY||!output.isTTY||typeof directory!=='string')throw new Error('explicit_interactive_enrollment_required');
 const root=fs.realpathSync(fileURLToPath(new URL('..',import.meta.url))),target=path.resolve(directory),parent=fs.realpathSync(path.dirname(target));
 const parentStat=fs.lstatSync(parent);if(target!==path.join(parent,path.basename(target))||target===root||target.startsWith(root+path.sep)||fs.existsSync(target)||!parentStat.isDirectory()||parentStat.uid!==process.getuid()||parentStat.mode&0o022)throw new Error('new_private_directory_required');
 fs.mkdirSync(target,{mode:0o700});const initial=fs.lstatSync(target),files=[];let rl,committed=false;const session=enrollment??new Enrollment({enable:true});
 const privateDirectory=()=>{const p=fs.lstatSync(parent),s=fs.lstatSync(target);if(p.dev!==parentStat.dev||p.ino!==parentStat.ino||p.uid!==process.getuid()||p.mode&0o022||s.dev!==initial.dev||s.ino!==initial.ino||!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077||fs.realpathSync(target)!==target)throw new Error('private_directory_changed');};
 const prompt=ask??(q=>{rl??=createInterface({input,output});return rl.question(q);});
 const write=(name,value)=>{privateDirectory();const file=path.join(target,name);fs.writeFileSync(file,value,{mode:0o600,flag:'wx'});files.push(file);return file;};
 try{
  if(await prompt('Type RECEIVE to begin your own five-minute QR session: ')!=='RECEIVE')throw new Error('enrollment_cancelled');
  let status=await session.start({persist:true,receive:true,send:allowSend});const id=status.session_id;write('qr-content.txt',session.qrContent(id));output.write('QR content is in the private directory. Open it locally; do not share or log it.\n');
  while(status.state!=='confirmed'){
   if(status.state==='expired')throw new Error('enrollment_expired');
   let code;if(status.state==='need_verifycode'){rl?.close();rl=null;code=secretPrompt?await secretPrompt():await readVerificationCode(input,output,status.expires_at_ms-Date.now());}
   else if(await prompt('After your own scan, press Enter to poll once; type STOP to cancel: ')==='STOP')throw new Error('enrollment_cancelled');status=await session.poll(id,code);
  }
  write('owner-confirmation.json',JSON.stringify({bot_id:status.bot_id,owner_peer_id:status.owner_peer_id,send_consent:allowSend},null,2)+'\n');
  if(await prompt('Inspect owner-confirmation.json locally. Type CONFIRM OWNER only if it is your account: ')!=='CONFIRM OWNER')throw new Error('owner_confirmation_required');
  const binding=session.confirm(id,{ownerPeerId:status.owner_peer_id,botId:status.bot_id,confirmOwner:true});write('binding.json',JSON.stringify(binding,null,2)+'\n');committed=true;
  output.write('Private binding saved. No message was polled or sent. Import it explicitly into your separate server configuration.\n');return {saved:true,sent:false};
 }finally{session.cancel();rl?.close();privateDirectory();for(const file of files)if(!committed||path.basename(file)!=='binding.json')fs.rmSync(file,{force:true});if(!committed)fs.rmdirSync(target);}
}
if(isMain(import.meta.url)){
 try{await enrollLocal(enrollmentArguments(process.argv.slice(2)));}catch{console.error('Enrollment stopped. No credentials are printed; check the explicit local workflow.');process.exitCode=1;}
}
