import fs from 'node:fs';
import path from 'node:path';
import {isMain} from '../src/private-files.mjs';
import {readConfig} from '../src/config.mjs';
import {stateSchema} from '../src/state-schema.mjs';
export function switchRelease({root,release,configFile}){
  if(typeof release!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(release)||['.','..'].includes(release))throw new Error('invalid_release');
  root=fs.realpathSync(root);const releases=path.join(root,'releases'),target=path.join(releases,release),{config,key}=readConfig(configFile);
  try{
  if(fs.realpathSync(target)!==target||!fs.statSync(path.join(target,'src/server.mjs')).isFile()||!fs.statSync(path.join(target,'package.json')).isFile())throw new Error('release_required');
  const privateFiles=[config.state.database,config.state.keyFile,path.resolve(configFile),config.auth.tokenFile,config.auth.jwksFile,config.real?.bindingFile].filter(Boolean);
  const insideRelease=file=>file===releases||file.startsWith(releases+path.sep);
  for(const file of privateFiles){
    // Check lexical paths and existing ancestors: a secret reached through an
    // outside symlink must not actually live in a replaceable release either.
    let ancestor=file;while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
    if(insideRelease(file)||insideRelease(fs.realpathSync(ancestor)))throw new Error('state_must_live_outside_releases');
  }
  // Never copy, replace or restore the database. A live/stale writer lock is a
  // hard stop; recovering an actually crashed process is a separate command.
  if(fs.existsSync(config.state.database+'.lock'))throw new Error('stop_writer_first');
  const pkg=JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8')),targetSchema=pkg.bridgeStateSchema??(pkg.name==='weixin-mcp-bridge'&&pkg.version==='0.1.0'?1:null),existingSchema=stateSchema(config.state.database,key);
  if(![1,2].includes(targetSchema)||existingSchema!==null&&existingSchema!==targetSchema)throw new Error('state_schema_incompatible');
  const current=path.join(root,'current'),existing=fs.lstatSync(current,{throwIfNoEntry:false});if(existing&&!existing.isSymbolicLink())throw new Error('current_must_be_symlink');
  const temporary=path.join(root,'.current-switch-'+process.pid);fs.symlinkSync(path.join('releases',release),temporary,'dir');try{fs.renameSync(temporary,current);}catch(e){fs.unlinkSync(temporary);throw e;}
  return {switched:true,release,database_restored:false,server_started:false};
  }finally{key.fill(0);}
}
if(isMain(import.meta.url)){try{const arg=n=>{const i=process.argv.indexOf(n);if(i<0||!process.argv[i+1])throw 0;return process.argv[i+1];};console.log(JSON.stringify(switchRelease({root:arg('--root'),release:arg('--release'),configFile:arg('--config')})));}catch{console.error('Release switch rejected; stop the writer and keep private state/configuration outside release directories.');process.exitCode=1;}}
