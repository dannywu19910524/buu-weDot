import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {scanTree} from './scan-public.mjs';
import {isMain} from '../src/private-files.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
export function treeManifest(root){
  const entries=[];
  function walk(dir,relative=''){
    for(const name of fs.readdirSync(dir).sort()){
      const rel=relative?relative+'/'+name:name,file=path.join(dir,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()||!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1))throw new Error('unsafe_tree');
      if(stat.isDirectory())walk(file,rel);
      else{const bytes=fs.readFileSync(file);entries.push({path:rel,size:bytes.length,sha256:digest(bytes)});}
    }
  }
  walk(root);entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  // Canonical key order matches the original frozen-tree audit definition.
  const canonical=entries.map(({path:p,size,sha256})=>({path:p,sha256,size}));
  return {algorithm:'sha256-sorted-path-size-sha256-json-v1',tree_hash:digest(JSON.stringify(canonical)),files:entries};
}

export function verifyRelease(root=fileURLToPath(new URL('..',import.meta.url))){
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major!==24||minor<21)throw new Error('node_24_21_or_later_24_required');
  const report={schema:'release-verification-v1',node:process.versions.node,platform:process.platform,arch:process.arch,cloud_subscription_verified:false,real_weixin_verified:false};
  if(process.platform==='win32')throw new Error('posix_required');
  const scan=scanTree(root);if(!scan.passed)throw new Error('public_scan_failed');
  const before=treeManifest(root),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if(pkg.private!==true||pkg.license!=='MIT'||pkg.bridgeStateSchema!==2||Object.keys(pkg.dependencies??{}).length||Object.keys(pkg.devDependencies??{}).length)throw new Error('candidate_metadata_changed');
  const license=fs.readFileSync(path.join(root,'LICENSE'),'utf8');
  if(!license.startsWith('MIT License\n\nCopyright (c) 2026 buu\n')||!license.includes('The above copyright notice and this permission notice shall be included'))throw new Error('license_text_missing');
  report.release={stage:'source',license_selected:'MIT',copyright_holder:'buu',remote_publication_verified:false};
  for(const entry of before.files.filter(x=>x.path.endsWith('.mjs'))){
    const source=fs.readFileSync(path.join(root,entry.path),'utf8');
    // This covers the candidate's static imports. It is not a general JS parser.
    for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"\n]+)\1/g)){
      const specifier=match[2];if(!specifier.startsWith('node:')&&!specifier.startsWith('./')&&!specifier.startsWith('../'))throw new Error('unreviewed_import');
      if(!specifier.startsWith('node:')){const target=path.resolve(root,path.dirname(entry.path),specifier),rel=path.relative(root,target);if(rel.startsWith('..')||path.isAbsolute(rel)||!fs.statSync(target).isFile())throw new Error('import_outside_candidate');}
    }
  }
  const run=args=>{const child=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});if(child.error||child.status!==0)throw new Error('validation_stage_failed');return child.stdout;};
  const tests=fs.readdirSync(path.join(root,'tests')).filter(x=>x.endsWith('.test.mjs')).sort().map(x=>'tests/'+x);
  const tap=run(['--test','--test-reporter=tap',...tests]),number=label=>{const match=new RegExp('^# '+label+' (\\d+)$','m').exec(tap);if(!match)throw new Error('test_summary_missing');return Number(match[1]);};
  report.tests={total:number('tests'),passed:number('pass'),failed:number('fail'),cancelled:number('cancelled'),skipped:number('skipped'),todo:number('todo')};
  if(report.tests.total===0||report.tests.passed!==report.tests.total||report.tests.failed||report.tests.cancelled||report.tests.skipped||report.tests.todo)throw new Error('incomplete_test_run');
  report.demos={};
  for(const [name,file] of [['mock','scripts/demo-mock.mjs'],['features','scripts/demo-features.mjs']]){
    const result=JSON.parse(run([file]).trim());
    if(result.ok!==true||result.provider_calls!==0||result.external_network_calls!==0||result.cloud_subscription_verified!==false)throw new Error('mock_boundary_failed');
    report.demos[name]=result;
  }
  const after=treeManifest(root);if(before.tree_hash!==after.tree_hash)throw new Error('source_changed_during_validation');
  return {...report,passed:true,scan,manifest:after};
}
if(isMain(import.meta.url)){
  try{if(process.argv.length!==2)throw new Error('no_arguments_expected');console.log(JSON.stringify(verifyRelease(),null,2));}
  catch(e){const reason=['node_24_21_or_later_24_required','posix_required','no_arguments_expected'].includes(e.message)?e.message:'release_validation_failed';console.log(JSON.stringify({schema:'release-verification-v1',passed:false,reason}));process.exitCode=1;}
}
