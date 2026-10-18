'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const common = require('./release-common.cjs');
const {stamp,TARGETS} = require('./vscode-candidate.cjs');
const {release,candidates} = require('./release-vscode.cjs');
const {registries,publishRegistry,verificationOptions} = require('./vscode-registries.cjs');
const {PINS,runTool,publicationEnvironment} = require('./vscode-tools.cjs');
const {RECORD} = require('./release-model.cjs');
const SHA = 'a'.repeat(40);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'heaplens-vscode-release-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const write = (name,value) => { fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true}); fs.writeFileSync(path.join(root,name),value); };
  const manifest = {name:'heaplens',publisher:'publisher',version:'1.0.35'};
  write('package.json',JSON.stringify(manifest));
  write('scripts/ci/release-plan.json',JSON.stringify({schema:1,repository:'owner/repo',versions:{vscode:manifest.version},notes:{
    vscode:{baseline:{version:'1.0.34',commit:'b'.repeat(40)},entries:[]},intellij:{entries:[]},cli:{entries:[]}
  }}));
  const directory = path.join(root,'artifacts'); fs.mkdirSync(directory);
  for (const target of TARGETS) {
    const stage = path.join(root,target); fs.mkdirSync(stage);
    fs.mkdirSync(path.join(stage,'extension'));
    fs.writeFileSync(path.join(stage,'extension/package.json'),JSON.stringify(manifest));
    fs.writeFileSync(path.join(stage,'extension.vsixmanifest'),`<PackageManifest><Metadata><Identity Id="heaplens" Publisher="publisher" Version="1.0.35" TargetPlatform="${target}"/></Metadata></PackageManifest>`);
    const name = `heaplens-${target}-1.0.35.vsix`;
    execFileSync('zip',['-qr',path.join(stage,name),'extension','extension.vsixmanifest'],{cwd:stage});
    stamp({directory:stage,target,sha:SHA,manifest});
    for (const file of [name,`vsix-${target}.json`]) fs.copyFileSync(path.join(stage,file),path.join(directory,file));
  }
  let publishedRelease = null;
  const assets = [], writes = [];
  const gh = args => {
    if (args[0] === 'api' && args[1].includes('/releases/tags/')) {
      if (!publishedRelease) { const error=new Error('Not Found'); error.stderr='HTTP 404'; throw error; }
      return JSON.stringify({...publishedRelease,assets});
    }
    if (args[0] === 'api' && args[1].includes('/assets?')) return JSON.stringify(assets);
    if (args[0] === 'release' && ['create','upload'].includes(args[1])) {
      writes.push(args);
      publishedRelease ||= {id:1,draft:false};
      for (const file of args.filter(arg=>fs.existsSync(arg) && fs.lstatSync(arg).isFile()))
        assets.push({name:path.basename(file),digest:'sha256:' + common.sha256(fs.readFileSync(file))});
      return '';
    }
    assert.fail('unexpected gh request: ' + args.join(' '));
  };
  const state = [new Map(),new Map()];
  const registryList = state.map((values,index) => ({name:['Marketplace','Open VSX'][index],async lookup(candidate){return values.get(candidate.target) || null;}}));
  const env = {GITHUB_WORKSPACE:root,GITHUB_REF:'refs/tags/v1.0.35',GITHUB_SHA:SHA,GITHUB_REPOSITORY:'owner/repo',ARTIFACT_DIR:directory};
  return {root,directory,manifest,gh,writes,state,registryList,assets,env};
}
test('VSIX candidates bind every platform to the exact version, embedded identity, source commit and checksum', t => {
  const f = fixture(t), unzip = args=>common.run('unzip',args);
  const input = {directory:f.directory,version:f.manifest.version,sha:SHA,manifest:f.manifest,unzip};
  assert.equal(candidates(input).length,4);
  assert.throws(()=>candidates({...input,sha:'b'.repeat(40)}), /provenance mismatch/);
  const file = path.join(f.directory,`vsix-${TARGETS[0]}.json`), record=JSON.parse(fs.readFileSync(file,'utf8'));
  record.file='../outside.vsix'; fs.writeFileSync(file,JSON.stringify(record));
  assert.throws(()=>candidates(input), /provenance mismatch/);
});
test('every partial platform/registry failure resumes from original artifacts without reuploading successful targets', async t => {
  for (let failAt=0; failAt<8; failAt+=1) {
    const f=fixture(t), attempts=[], successes=[];
    let fail=true;
    const upload=async(registry,candidate)=>{
      const index=f.registryList.indexOf(registry), position=index*4+TARGETS.indexOf(candidate.target);
      attempts.push(position);
      if (position===failAt && fail) {fail=false;throw new Error('network failure');}
      assert.equal(f.state[index].has(candidate.target),false,'must never upload an existing target again');
      f.state[index].set(candidate.target,candidate.sha256); successes.push(position);
    };
    const options={git(){},gh:f.gh,registryList:f.registryList,upload,verify:{attempts:1,delayMs:0},log(){}};
    await assert.rejects(release(f.env,options),/could not be verified/);
    assert.equal(f.assets.some(asset=>asset.name===RECORD),false,'partial publication must not become a baseline');
    assert.equal(await release(f.env,options),'published');
    assert.deepEqual(successes,[0,1,2,3,4,5,6,7]);
    assert.equal(f.assets.filter(asset=>asset.name===RECORD).length,1);
    const count=attempts.length;
    assert.equal(await release(f.env,options),'published');
    assert.equal(attempts.length,count,'a completed rerun must not upload anything');
  }
});
test('an upload accepted before a lost response is verified instead of duplicated', async()=>{
  const values=new Map(), candidate={target:'linux-x64',version:'1.0.35',sha256:'a'.repeat(64)};
  let uploads=0;
  const registry={name:'test',async lookup(item){return values.get(item.target)||null;}};
  await publishRegistry({registry,candidates:[candidate],upload:async()=>{uploads+=1;values.set(candidate.target,candidate.sha256);throw new Error('response lost');},verify:{attempts:1,delayMs:0},log(){}});
  assert.equal(uploads,1);
});
test('conflicting bytes, ambiguous visibility and registry errors fail closed rather than skip or overwrite', async()=>{
  const candidates=[{target:'darwin-arm64',version:'1.0.35',sha256:'a'.repeat(64)},{target:'linux-x64',version:'1.0.35',sha256:'b'.repeat(64)}];
  let uploads=0;
  await assert.rejects(publishRegistry({registry:{name:'test',async lookup(item){return item.target==='linux-x64'?'c'.repeat(64):null;}},candidates,upload(){uploads+=1;},log(){}}),/conflicting bytes/);
  assert.equal(uploads,0,'preflight all platforms before the first write');
  await assert.rejects(publishRegistry({registry:{name:'test',async lookup(){throw new Error('HTTP 503');}},candidates,upload(){uploads+=1;}}),/503/);
  assert.equal(uploads,0);
  await assert.rejects(publishRegistry({registry:{name:'test',async lookup(){return null;}},candidates:[candidates[0]],upload(){uploads+=1;},verify:{attempts:1,delayMs:0},log(){}}),/could not be verified/);
  assert.equal(uploads,1,'no blind repeated upload for delayed visibility');
});
test('verification permits fifteen minutes by default, honors bounded overrides and does not blindly repeat an accepted upload', async()=>{
  const options=verificationOptions({});
  assert.equal((options.attempts-1)*options.delayMs,900000);
  const short=verificationOptions({HEAPLENS_RELEASE_VERIFY_SECONDS:'60'});
  assert.equal((short.attempts-1)*short.delayMs,60000);
  for(const value of ['0','-1','3601','1.5','abc'])assert.throws(()=>verificationOptions({HEAPLENS_RELEASE_VERIFY_SECONDS:value}),/integer from 1 to 3600/);
  const candidate={target:'darwin-arm64',version:'1.0.35',sha256:'a'.repeat(64)};
  let lookups=0,uploads=0;
  const registry={name:'delayed visibility',async lookup(){lookups+=1;return lookups<5?null:candidate.sha256;}};
  await publishRegistry({registry,candidates:[candidate],upload(){uploads+=1;},verify:{attempts:5,delayMs:0},log(){}});
  assert.equal(uploads,1);assert.equal(lookups,5);
});
test('a confirmed byte conflict after upload is not retried for the full visibility window', async()=>{
  let lookups=0;
  const candidate={target:'linux-x64',version:'1.0.35',sha256:'a'.repeat(64)};
  await assert.rejects(publishRegistry({registry:{name:'test',async lookup(){lookups+=1;return lookups===1?null:'b'.repeat(64);}},
    candidates:[candidate],upload(){},verify:{attempts:46,delayMs:20000},log(){}}),/conflicting bytes/);
  assert.equal(lookups,2);
});
test('release tools are exact pins shared by build and publish, with only the selected registry credential',()=>{
  for(const [tool,pin] of Object.entries(PINS)){
    assert.match(pin,/@\d+\.\d+\.\d+$/);
    let call;
    runTool(tool,['--version'],{},(...args)=>{call=args;return '';});
    assert.deepEqual(call.slice(0,2),['npx',['--yes',pin,'--version']]);
  }
  assert.throws(()=>runTool('untrusted',['publish']),/Unknown release tool/);
  // npx.cmd needs a shell on Windows runners; elsewhere no shell is involved.
  let call;
  runTool('ovsx',['publish','--packagePath','/tmp/heaplens-win32-x64-1.0.35.vsix'],{},(...args)=>{call=args;return '';},'win32');
  assert.equal(call[2].shell,true);
  runTool('ovsx',['--version'],{},(...args)=>{call=args;return '';},'linux');
  assert.equal(call[2].shell,undefined);
  assert.throws(()=>runTool('ovsx',['--packagePath','a b.vsix'],{},()=>'' ,'win32'),/Unsafe release tool argument/);
  const env=publicationEnvironment({PATH:'/bin',GH_TOKEN:'github',VSCE_PAT:'market',OVSX_PAT:'openvsx',NODE_AUTH_TOKEN:'npm'},'VSCE_PAT');
  assert.deepEqual(env,{PATH:'/bin',VSCE_PAT:'market'});
});
test('registry adapters query the exact version/platform and independently hash downloaded bytes', async()=>{
  const candidate={publisher:'publisher',extension:'heaplens',version:'1.0.35',target:'darwin-arm64'};
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});
    if(url.includes('extensionquery'))return {ok:true,json:async()=>({results:[{extensions:[{extensionName:'heaplens',publisher:{publisherName:'publisher'},versions:[
      {version:'1.0.35',targetPlatform:'linux-x64',files:[{assetType:'Microsoft.VisualStudio.Services.VSIXPackage',source:'https://packages.invalid/wrong'}]},
      {version:'1.0.35',targetPlatform:'darwin-arm64',files:[{assetType:'Microsoft.VisualStudio.Services.VSIXPackage',source:'https://packages.invalid/right'}]}
    ]}]}]})};
    if(url.includes('open-vsx.org/api/'))return {ok:true,json:async()=>({...candidate,namespace:'publisher',name:'heaplens',targetPlatform:'darwin-arm64',files:{download:'https://packages.invalid/right'}})};
    assert.equal(url,'https://packages.invalid/right');
    return {ok:true,arrayBuffer:async()=>Buffer.from('verified bytes')};
  };
  for(const registry of registries(fetchImpl))assert.equal(await registry.lookup(candidate),common.sha256('verified bytes'));
  assert.ok(calls.some(call=>call.url.endsWith('/publisher/heaplens/darwin-arm64/1.0.35')));
  assert.equal(JSON.parse(calls[0].options.body).filters[0].criteria[0].value,'publisher.heaplens');
});
