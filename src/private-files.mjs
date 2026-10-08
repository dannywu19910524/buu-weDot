import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export function isMain(url){try{return !!process.argv[1]&&url===pathToFileURL(fs.realpathSync(process.argv[1])).href;}catch{return false;}}
export function privateFile(file){
  // A FIFO can block open() before fstat() has a chance to reject it. Opening
  // without waiting lets the existing regular-file check reject special files.
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||stat.mode&0o077)throw new Error('private_file_required');
    if(stat.size>65536)throw new Error('private_file_too_large');const bytes=Buffer.alloc(65537),n=fs.readSync(fd,bytes,0,bytes.length,0);if(n>65536)throw new Error('private_file_too_large');return bytes.subarray(0,n).toString('utf8').trim();
  }finally{fs.closeSync(fd);}
}
export function writerLock(database){
  if(database===':memory:')return {release(){}};
  const file=database+'.lock';let fd;
  try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({profile:'weixin-mcp-writer-v1',pid:process.pid}));fs.fsyncSync(fd);}catch{if(fd!==undefined)fs.closeSync(fd);throw new Error('writer_active_or_stale_lock');}
  const initial=fs.fstatSync(fd);let released=false;
  return {release(){if(released)return;released=true;try{const current=fs.lstatSync(file);if(current.dev!==initial.dev||current.ino!==initial.ino||current.isSymbolicLink()||current.nlink!==1)throw new Error('writer_lock_changed');fs.unlinkSync(file);}finally{fs.closeSync(fd);}}};
}
export function recoverLock(database,{confirmStopped=false}={}){
  if(!confirmStopped||!path.isAbsolute(database))throw new Error('confirm_stopped_required');const file=database+'.lock',before=fs.lstatSync(file),record=JSON.parse(privateFile(file));
  if(record.profile!=='weixin-mcp-writer-v1'||!Number.isSafeInteger(record.pid)||record.pid<1)throw new Error('invalid_lock');
  try{process.kill(record.pid,0);throw new Error('writer_still_running');}catch(e){if(e.code!=='ESRCH')throw new Error('writer_may_be_running');}
  const after=fs.lstatSync(file);if(before.dev!==after.dev||before.ino!==after.ino)throw new Error('writer_lock_changed');fs.unlinkSync(file);return {removed_stale_lock:true};
}
