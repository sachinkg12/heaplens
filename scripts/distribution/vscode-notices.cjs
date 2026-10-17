'use strict';
// VSIX-only adapter over the same dependency-notice generator used by the other packages.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {dependencyNotices}=require('./licenses.cjs');
const {readRegular,write,inventory,digest}=require('./files.cjs');
const ROOT=path.resolve(__dirname,'../..'),MARKER='heaplens-rust-notices-v1',MANIFEST='THIRD_PARTY_NOTICES.json';

function verifyOwned(directory) {
 if(!fs.lstatSync(directory).isDirectory())throw Error('Notices output must be a real directory');
 const manifest=JSON.parse(readRegular(path.join(directory,MANIFEST)));
 if(manifest.generated_by!==MARKER||!Array.isArray(manifest.files))throw Error('Refusing to replace unowned notices');
 const actual=inventory(directory).filter(file=>file.path!==MANIFEST);
 if(JSON.stringify(actual)!==JSON.stringify(manifest.files))throw Error('Refusing to replace modified notices');
}
function stage(metadata,destination) {
 const parent=path.dirname(destination);
 fs.mkdirSync(parent,{recursive:true});
 if(!fs.lstatSync(parent).isDirectory())throw Error('Notices parent must be a real directory');
 if(fs.existsSync(destination))verifyOwned(destination);
 const temporary=fs.mkdtempSync(path.join(parent,'.notices-building-'));
 let retired;
 try {
  const rust=dependencyNotices(metadata,temporary);
  write(temporary,MANIFEST,JSON.stringify({schema_version:1,generated_by:MARKER,rust,files:inventory(temporary)},null,2)+'\n');
  if(fs.existsSync(destination)) {
   verifyOwned(destination);
   retired=destination+'.retired-'+crypto.randomUUID();
   fs.renameSync(destination,retired);
  }
  try { fs.renameSync(temporary,destination); }
  catch(error) { if(retired)fs.renameSync(retired,destination); retired=undefined; throw error; }
  if(retired)fs.rmSync(retired,{recursive:true}); // Exact unchanged, generated directory verified above.
  return {dependencies:rust.length,files:inventory(destination).length};
 } finally {
  if(fs.existsSync(temporary))fs.rmSync(temporary,{recursive:true}); // Exact fresh build directory only.
 }
}
function main() {
 const manifest=path.join(ROOT,'hprof-analyzer/Cargo.toml');
 const target=process.env.CARGO_BUILD_TARGET||execFileSync('rustc',['--version','--verbose'],{encoding:'utf8'}).match(/^host: (.+)$/m)?.[1];
 if(!target||!/^[a-z0-9_]+(?:-[a-z0-9_]+){2,}$/.test(target))throw Error('Invalid Rust package target');
 // Own the fetch contract here, rather than relying on every workflow to remember it.
 execFileSync('cargo',['fetch','--locked','--target',target,'--manifest-path',manifest],{stdio:'pipe',maxBuffer:8*1024*1024});
 const metadata=JSON.parse(execFileSync('cargo',['metadata','--offline','--locked','--format-version','1','--filter-platform',target,'--manifest-path',manifest],{maxBuffer:32*1024*1024}));
 console.log('VSIX Rust notices: '+JSON.stringify(stage(metadata,path.join(ROOT,'bin/rust-notices'))));
}
if(require.main===module){try{main();}catch(error){console.error('VSIX notice staging failed: '+error.message);process.exitCode=1;}}
module.exports={stage,verifyOwned};
