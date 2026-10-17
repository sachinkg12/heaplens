'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {stage}=require('./vscode-notices.cjs');
function fixture(root){
 const sources=path.join(root,'sources');fs.mkdirSync(sources);
 fs.writeFileSync(path.join(sources,'LICENSE_A2'),'Example upstream license, unchanged.\n');
 return {resolve:{root:'engine',nodes:[{id:'engine',deps:[{pkg:'hash',dep_kinds:[{kind:null}]}]},{id:'hash',deps:[]}]},
  packages:[{id:'engine'},{id:'hash',name:'example-hash',version:'1.0.0',manifest_path:path.join(sources,'Cargo.toml'),license:'Apache-2.0',authors:['Upstream Author'],repository:'https://example.invalid/upstream'}]};
}
test('VSIX notices reuse shared license generation and replace only unchanged owned output',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'heaplens-notices-contract-'));
 try{const metadata=fixture(root),out=path.join(root,'bin/rust-notices');
  assert.equal(stage(metadata,out).dependencies,1);assert.equal(stage(metadata,out).dependencies,1);
  const record=JSON.parse(fs.readFileSync(path.join(out,'THIRD_PARTY_NOTICES.json')));
  assert.equal(record.rust[0].authors[0],'Upstream Author');
  assert.equal(fs.readFileSync(path.join(out,record.rust[0].notices[0]),'utf8'),'Example upstream license, unchanged.\n');
  fs.writeFileSync(path.join(out,'user-file'),'preserve');
  assert.throws(()=>stage(metadata,out),/modified notices/);
  assert.equal(fs.readFileSync(path.join(out,'user-file'),'utf8'),'preserve');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('VSIX notice staging rejects unowned directories and symlink outputs',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'heaplens-notices-contract-'));
 try{const metadata=fixture(root),out=path.join(root,'bin/rust-notices');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'THIRD_PARTY_NOTICES.json'),'{}');
  assert.throws(()=>stage(metadata,out),/unowned notices/);
  if(process.platform!=='win32'){const link=path.join(root,'link');fs.symlinkSync(out,link);assert.throws(()=>stage(metadata,link),/real directory/);}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('VSIX prepublish includes notices and target-specific metadata without publication',()=>{
 const root=path.resolve(__dirname,'../..'),manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
 assert.match(manifest.scripts['vscode:prepublish'],/node scripts\/distribution\/vscode-notices\.cjs/);
 assert.match(fs.readFileSync(path.join(root,'.vscodeignore'),'utf8'),/^!bin\/rust-notices\/\*\*$/m);
 const yaml=require('js-yaml'),jobs=yaml.load(fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8')).jobs;
 const step=jobs.build.steps.find(step=>step.name==='Package VSIX');
 assert.equal(step.env.CARGO_BUILD_TARGET,'${{ matrix.rust_target }}');
 const source=fs.readFileSync(path.join(__dirname,'vscode-notices.cjs'),'utf8');
 assert.ok(source.indexOf("'fetch','--locked'")<source.indexOf("'metadata','--offline','--locked'"));
 assert.doesNotMatch(source,/vsce publish|git push|git tag/);
});
