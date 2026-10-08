import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDecipheriv} from 'node:crypto';
export const STATE_PROFILE='weixin-mcp-extended-v2';
export const STATE_SCHEMA=2;
// Read-only preflight for code switching. Never migrate or restore the ledger.
export function stateSchema(database,key){
 if(!fs.existsSync(database))return null;const stat=fs.lstatSync(database),dir=fs.lstatSync(path.dirname(database));if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.nlink!==1||stat.mode&0o077||!dir.isDirectory()||dir.uid!==process.getuid()||dir.mode&0o077||fs.realpathSync(path.dirname(database))!==path.dirname(database))throw new Error('private_storage_required');
 if(stat.size===0)return null;let db;
 try{db=new DatabaseSync(database,{readOnly:true});const value=db.prepare("SELECT value FROM bridge_meta WHERE name='identity'").get()?.value;if(typeof value!=='string'||value.length>8192)throw 0;const bytes=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAAD(Buffer.from('identity'));c.setAuthTag(bytes.subarray(-16));const v=JSON.parse(Buffer.concat([c.update(bytes.subarray(12,-16)),c.final()]));if(v.profile===STATE_PROFILE)return STATE_SCHEMA;if(v.profile==='weixin-mcp-text-v1')return 1;throw 0;}catch{throw new Error('state_schema_unknown');}finally{db?.close();}
}
