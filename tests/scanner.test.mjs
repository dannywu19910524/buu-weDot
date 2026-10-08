import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {scanTree} from '../scripts/scan-public.mjs';

function tree(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-scan-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function write(dir,file,body='Synthetic fixture'){const p=path.join(dir,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,body);return p;}
const cases=[
  ['private_key',()=>['-----BEGIN ','PRIVATE KEY-----'].join('')],
  ['jwt_literal',()=>['eyJ'+'a'.repeat(20),'b'.repeat(20),'c'.repeat(20)].join('.')],
  ['credential_prefix',()=>['sk-','a'.repeat(24)].join('')],
  ['personal_home_path',()=>['/Users','/synthetic/example'].join('')],
  ['personal_email',()=>['synthetic','@','unreviewed','vendor','.dev'].join('')],
  ['persistent_uuid',()=>[8,4,4,4,12].map(n=>'a'.repeat(n)).join('-')],
  ['opaque_identifier',()=> 'a'.repeat(32)],
  ['embedded_binary',()=> ['data:image/png;','base64,','a'.repeat(24)].join('')],
  ['invisible_text',()=>String.fromCodePoint(0x202e)],
  ['unreviewed_url_host',()=> ['https://','unreviewed','vendor','.dev','/'].join('')],
  ['url_credentials',()=> 'https://'+'synthetic:synthetic'+'@callbacks.example.com/'],
  ['credential_url_query',()=> 'https://callbacks.example.com/?'+['token','synthetic'].join('=')],
  ['credential_literal',()=> ['botToken',': "','synthetic','"'].join('')],
  ['bearer_literal',()=> ['Bearer ','a'.repeat(20)].join('')],
  ['opaque_literal',()=> '"'+'A'.repeat(64)+'"'],
];
for(const [rule,body] of cases)test('scanner detects '+rule+' without exposing matched values',t=>{
  const dir=tree(t);write(dir,'example.md',body());const result=scanTree(dir);
  assert.equal(result.passed,false);assert.ok(result.findings.some(x=>x.rule===rule));
  assert.ok(result.findings.every(x=>Object.keys(x).sort().join(',')==='line,path,rule'));
});
for(const file of ['.git/record.txt','node_modules/record.txt','state.sqlite','image.png'])test('scanner rejects prohibited artifact '+file,t=>{
  const dir=tree(t);write(dir,file);assert.equal(scanTree(dir).passed,false);
});
test('scanner rejects symlinks without reading outside the tree',t=>{
  const dir=tree(t);fs.symlinkSync(path.join(dir,'absent'),path.join(dir,'link.md'));
  assert.deepEqual(scanTree(dir).findings,[{path:'link.md',rule:'symlink_forbidden',line:null}]);
});
test('scanner rejects hard links',t=>{
  const dir=tree(t),file=write(dir,'one.md');fs.linkSync(file,path.join(dir,'two.md'));
  assert.equal(scanTree(dir).findings.filter(x=>x.rule==='nonregular_or_hardlink').length,2);
});
test('scanner rejects non-UTF8 and binary content',t=>{
  const dir=tree(t);write(dir,'utf.md',Buffer.from([255]));write(dir,'binary.md',Buffer.from([0]));
  assert.deepEqual(new Set(scanTree(dir).findings.map(x=>x.rule)),new Set(['non_utf8_file','binary_file']));
});
test('scanner private denylist detects content and redacts matching paths',t=>{
  const dir=tree(t);write(dir,'synthetic-sensitive.md','synthetic-sensitive');
  const result=scanTree(dir,{denylist:['synthetic-sensitive']});assert.equal(result.passed,false);
  assert.ok(result.findings.every(x=>x.path==='<redacted-path>'));assert.ok(result.findings.some(x=>x.rule==='private_denylist'));
});
test('scanner does not blanket-exempt test files',t=>{
  const dir=tree(t);write(dir,'tests/fixture.mjs',['botToken',': "','synthetic','"'].join(''));
  assert.ok(scanTree(dir).findings.some(x=>x.rule==='credential_literal'));
});
test('scanner accepts exact placeholders and reserved endpoints',t=>{
  const dir=tree(t);write(dir,'examples/config.json',JSON.stringify({botToken:'REPLACE_WITH_BOT_TOKEN',resource:'https://bridge.example.com/mcp'}));
  assert.equal(scanTree(dir).passed,true);
});
test('scanner accepts explicit SHA-256 fields without exempting other opaque strings',t=>{
  const dir=tree(t);write(dir,'manifest.json',JSON.stringify({sha256:'a'.repeat(64)}));assert.equal(scanTree(dir).passed,true);
  write(dir,'manifest.json',JSON.stringify({value:'a'.repeat(64)}));assert.equal(scanTree(dir).passed,false);
});
test('scanner rejects a runtime version file with extra content',t=>{
  const dir=tree(t);write(dir,'.node-version','24.21.0\nextra');assert.ok(scanTree(dir).findings.some(x=>x.rule==='invalid_runtime_version_file'));
});
test('scanner rejects an invalid denylist',t=>{assert.throws(()=>scanTree(tree(t),{denylist:['x']}),/invalid_denylist/);});
