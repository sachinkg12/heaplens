'use strict';
const fs=require('node:fs');
const path=require('node:path');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
module.exports=function localSearch(context){return {name:'heaplens-local-search',async postBuild({outDir}){
  const root=path.join(context.siteDir,'docs');
  const index=walk(root).filter(f=>/\.mdx?$/.test(f)).sort().map(file=>{
    const raw=fs.readFileSync(file,'utf8'),meta=raw.match(/^---\n([\s\S]*?)\n---/),title=meta?.[1].match(/^title:\s*(.+)$/m)?.[1].replace(/^['"]|['"]$/g,'')||path.basename(file,'.md');
    const body=raw.replace(/^---[\s\S]*?---\s*/,'').replace(/^import .+$/gm,'').replace(/<[^>]+>/g,' ').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\x60|[#*_|]/g,' ').replace(/\s+/g,' ').trim();
    return {title,url:'/docs/'+path.relative(root,file).replace(/\\/g,'/').replace(/\.mdx?$/,''),text:body};
  });
  fs.writeFileSync(path.join(outDir,'search-index.json'),JSON.stringify(index)+'\n');
}};};
