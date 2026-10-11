'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {walk}=require('./check-contracts.cjs');
const cheerio=require('cheerio');
function check(root=path.resolve(__dirname,'../build')){
  const pages=walk(root).filter(f=>f.endsWith('.html')),cache=new Map(),errors=[];
  for(const file of pages){const $=cheerio.load(fs.readFileSync(file,'utf8'));cache.set(file,$);}
  for(const [file,$] of cache){for(const element of $('[href],[src]').toArray()){
    const href=$(element).attr('href')||$(element).attr('src');if(!href||/^(?:https?:|mailto:|data:|javascript:)/.test(href))continue;
    const pageUrl='https://docs.test/heaplens/'+path.relative(root,file).replace(/\\/g,'/').replace(/index\.html$/,'');
    let url;try{url=new URL(href,pageUrl);}catch{errors.push(file+': invalid '+href);continue;}
    if(!url.pathname.startsWith('/heaplens/')){errors.push(file+': missing base URL '+href);continue;}
    const local=path.join(root,decodeURIComponent(url.pathname.slice('/heaplens/'.length)));
    let target=local;if(fs.existsSync(local)&&fs.statSync(local).isDirectory())target=path.join(local,'index.html');
    if(!fs.existsSync(target)&&fs.existsSync(local+'.html'))target=local+'.html';
    if(!fs.existsSync(target)){errors.push(file+': missing '+href);continue;}
    if(url.hash&&cache.has(target)){const id=decodeURIComponent(url.hash.slice(1));const target$=cache.get(target);if(!target$('[id]').toArray().some(e=>target$(e).attr('id')===id))errors.push(file+': missing fragment '+href);}
  }}
  assert.deepEqual(errors,[],'Broken local links');
  const entries=JSON.parse(fs.readFileSync(path.join(root,'search-index.json'),'utf8'));
  assert.equal(entries.length,walk(path.resolve(__dirname,'../docs')).filter(f=>/\.mdx?$/.test(f)).length,'Search coverage');
  console.log(JSON.stringify({html_pages:pages.length,search_pages:entries.length,broken_links:0}));
}
if(require.main===module){try{check(process.argv[2]?path.resolve(process.argv[2]):undefined);}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={check};
