'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const model = require('./release-model.cjs');
const notes = require('./release-notes.cjs');
const {prepare,refreshNotes,releaseDate,validDate} = require('./prepare-release.cjs');
const {validateTree} = require('./validate-release.cjs');
const {tagRelease, successfulRun, followsRelease} = require('./tag-release.cjs');
const baselines = require('./release-baselines.cjs');
function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-train-test-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const git = args => args[0] === 'ls-remote' ? '' : execFileSync('git', args, {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trimEnd();
  const write = (file, value) => { fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true}); fs.writeFileSync(path.join(root,file),value); };
  const read = file => fs.readFileSync(path.join(root,file),'utf8');
  const commit = message => { git(['add','-A']); git(['commit','-qm',message]); return git(['rev-parse','HEAD']); };
  git(['init','-q','-b','main']); git(['config','user.name','release test']); git(['config','user.email','test@example.invalid']);
  write('package.json', JSON.stringify({name:'heaplens',publisher:'publisher',version:'1.0.1'}));
  write('package-lock.json', JSON.stringify({version:'1.0.1',packages:{'':{version:'1.0.1'}}}));
  write('intellij-plugin/build.gradle.kts', 'version = "0.1.0"\n');
  write('intellij-plugin/src/main/resources/META-INF/plugin.xml', '<idea-plugin><change-notes><![CDATA[old]]></change-notes></idea-plugin>');
  write('scripts/distribution/config.json', JSON.stringify({version:'0.1.0',repository:'owner/repo'}));
  write('hprof-analyzer/Cargo.toml', '[package]\nname = "hprof-analyzer"\nversion = "0.1.0"\n');
  write('hprof-analyzer/Cargo.lock', 'version = 3\n\n[[package]]\nname = "hprof-analyzer"\nversion = "0.1.0"\n\n[[package]]\nname = "other"\nversion = "5.0.0"\n');
  write('CHANGELOG.md', '# Changelog\n\n## [1.0.1]\n\nHistorical notes unchanged.\n');
  write('scripts/ci/fixture.cjs', '// Test fixture for the existing scripts directory.\n');
  write('hprof-analyzer/src/lib.rs','old');
  const base = commit('Initial published fixture');
  const options = {};
  for (const host of Object.keys(model.HOSTS)) {
    options['--baseline-' + host] = base;
    options['--baseline-' + host + '-evidence'] = 'Verified manually published test fixture';
  }
  const setup = () => prepare({root,options,git,gh:()=>{throw new Error('No network expected');},date:'2026-10-17'});
  return {root,git,read,write,commit,base,options,setup};
}
test('notes exclude CI, publishing plumbing, docs, traffic and tests while correctly routing runtime code', () => {
  assert.deepEqual(notes.classify(['.github/workflows/ci.yml','scripts/ci/release-cli.cjs','scripts/distribution/build.cjs','scripts/distribution/distribution.test.cjs']), {hosts:[],shared:false});
  assert.deepEqual(notes.classify(['docs/site.md','traffic/day.json','src/test/test.ts','intellij-plugin/src/test/java/Foo.java']), {hosts:[],shared:false});
  assert.deepEqual(notes.classify(['src/extension.ts']), {hosts:['vscode'],shared:false});
  assert.deepEqual(notes.classify(['intellij-plugin/src/main/java/Editor.java']), {hosts:['intellij'],shared:false});
  assert.deepEqual(notes.classify(['browser-ui/server.cjs','scripts/distribution/launcher.cjs','hprof-analyzer/src/cli/mod.rs']), {hosts:['cli'],shared:false});
  assert.deepEqual(notes.classify(['hprof-analyzer/src/indexed/analysis.rs']), {hosts:['vscode','intellij','cli'],shared:true});
});
test('first-parent histories contribute merge titles once, preserve direct changes and reject side-branch baselines', t => {
  const r = repository(t);
  r.git(['checkout','-qb','feature']); r.write('hprof-analyzer/src/lib.rs','changed'); const side = r.commit('Implementation detail');
  r.git(['checkout','-q','main']); r.git(['merge','--no-ff','-qm','Merge pull request #42 from feature\n\nImprove shared graph construction','feature']);
  r.write('src/adapter.ts','fixed'); r.commit('Correct editor startup lifecycle');
  r.write('scripts/ci/test.cjs','internal'); r.commit('Improve publisher retry handling');
  const history = notes.history({baseline:r.base,head:r.git(['rev-parse','HEAD']),git:r.git});
  assert.equal(history.length,3);
  assert.equal(history[0].pr,42); assert.equal(history[0].title,'Improve shared graph construction');
  const section = notes.section({host:'vscode',baseline:{commit:r.base,version:'1.0.1'},changes:history});
  assert.equal(section.entries.length,2); assert.equal(section.entries[0].shared,true);
  assert.throws(() => notes.history({baseline:side,head:r.git(['rev-parse','HEAD']),git:r.git}), /first-parent/);
});
test('notes escape untrusted titles in Markdown, HTML and CDATA, and empty ranges are honest maintenance releases', () => {
  const section = {baseline:{version:'1.0.0',commit:'a'.repeat(40)},entries:[{title:'Fix <script> & ]]> [link](bad)',sha:'b'.repeat(40),pr:7,shared:true}]};
  assert.doesNotMatch(notes.html(section,'owner/repo'), /<script>|\]\]>/);
  assert.match(notes.html(section,'owner/repo'), /&lt;script&gt; &amp; \]\]&gt;/);
  assert.match(notes.markdown(section,'owner/repo'), /\\\[link\\\]/);
  assert.match(notes.markdown({...section,entries:[]},'owner/repo'), /no new user-facing changes/);
});
test('prepare updates seven version/note files plus plan/changelog, preserves unrelated files, and performs no Git writes', t => {
  const r = repository(t);
  r.write('hprof-analyzer/src/lib.rs','improved'); r.commit('Improve bounded graph construction');
  r.write('private-untracked.txt','user data');
  const calls = [];
  const result = prepare({root:r.root,options:r.options,git:args=>{calls.push(args);return r.git(args);},gh:()=>assert.fail('network'),date:'2026-10-17'});
  assert.deepEqual(result.plan.versions,{vscode:'1.0.2',intellij:'0.1.1',cli:'0.1.1'});
  assert.equal(result.files.length,9);
  assert.equal(r.read('private-untracked.txt'),'user data');
  assert.equal(result.plan.notes.intellij.entries[0].shared,true);
  assert.match(r.read('hprof-analyzer/Cargo.lock'), /name = "other"\nversion = "5.0.0"/);
  assert.match(r.read('CHANGELOG.md'), /Historical notes unchanged/);
  assert.ok(calls.every(args => !['push','tag','commit','checkout','switch'].includes(args[0]) || args[0] === 'tag' && args[1] === '--list'));
  assert.doesNotThrow(() => validateTree(r.root));
  const release = r.commit('Prepare coordinated release');
  assert.doesNotThrow(() => validateTree(r.root,{base:r.base,release:true,head:release}));
});
test('preview never edits versions, baselines require evidence, and tagged failed releases do not become baselines', t => {
  const r = repository(t);
  const before = r.read('package.json');
  const result = prepare({root:r.root,options:r.options,git:r.git,preview:true,date:'2026-10-17'});
  assert.match(result.changelog,/Coordinated maintenance release/); assert.equal(r.read('package.json'),before);
  assert.equal(fs.existsSync(path.join(r.root,model.PLAN)),false);
  assert.throws(() => prepare({root:r.root,git:r.git,options:{'--baseline-vscode':r.base}}), /verified manual baseline/);
  const gh = args => {
    if (args[0] === 'release' && args[1] === 'list') return JSON.stringify([{tagName:'v1.0.1',isDraft:false,isPrerelease:false}]);
    return JSON.stringify({assets:[]});
  };
  assert.throws(() => baselines.discover({host:'vscode',repository:'owner/repo',gh}), /No completed publication record/);
});
test('each explicit baseline reads only its host even when another host had a prototype version', t => {
  const r=repository(t);
  r.write('intellij-plugin/build.gradle.kts','version = "0.1.14-prototype"\n');
  const old=r.commit('Initial CLI packaging with a prototype IDE');
  r.write('intellij-plugin/build.gradle.kts','version = "0.1.16"\n'); r.commit('Prepare stable IDE package');
  r.options['--baseline-cli']=old;
  const result=prepare({root:r.root,git:r.git,options:r.options,preview:true});
  assert.equal(result.plan.notes.cli.baseline.version,'0.1.0');
  assert.equal(result.plan.notes.cli.baseline.commit,old);
  assert.equal(result.plan.versions.intellij,'0.1.17');
  assert.equal(fs.existsSync(path.join(r.root,model.PLAN)),false);
  assert.equal(model.hostVersion('cli',file=>{
    assert.equal(file,'scripts/distribution/config.json');return '{"version":"0.1.0"}';
  }),'0.1.0');
});
test('preparation checks fresh remote tags rather than an incomplete local tag list', t => {
  const r=repository(t), calls=[];
  assert.equal(r.git(['tag','--list']),'');
  const git=args=>{
    calls.push(args);
    return args[0]==='ls-remote' ? `${r.base}\trefs/tags/cli-v2.0.0\n` : r.git(args);
  };
  assert.throws(()=>prepare({root:r.root,git,options:r.options,preview:true}),/must exceed remote tags: cli/);
  assert.ok(calls.some(args=>args.join(' ')==='ls-remote --tags origin'));
  assert.equal(fs.existsSync(path.join(r.root,model.PLAN)),false);
});
test('release dates use the local calendar and permit an explicit reproducible override', t => {
  const now=new Date(2026,9,17,23,59);
  assert.equal(releaseDate(now),'2026-10-17');
  const output=execFileSync(process.execPath,['-e',`const {releaseDate}=require(${JSON.stringify(path.join(__dirname,'prepare-release.cjs'))});process.stdout.write(releaseDate(new Date('2026-10-18T02:00:00Z')));`],{
    env:{...process.env,TZ:'America/Los_Angeles'},encoding:'utf8'
  });
  assert.equal(output,'2026-10-17');
  assert.equal(validDate('2028-02-29'),'2028-02-29');
  for(const value of ['2026-02-29','2026-13-01','tomorrow','2026-1-1'])assert.throws(()=>validDate(value),/real YYYY-MM-DD/);
  const r=repository(t);
  const result=prepare({root:r.root,git:r.git,options:{...r.options,'--date':'2026-10-16'},preview:true});
  assert.equal(result.plan.date,'2026-10-16');
});
test('automatic baselines use completed records and skip pending or hidden IntelliJ submissions', t => {
  const r=repository(t);
  const payload={schema:1,host:'intellij',version:'0.1.0',commit:r.base,tag:'intellij-v0.1.0',status:'submitted',update_id:99};
  const gh=args=>{
    if(args[0]==='release' && args[1]==='list')return JSON.stringify([{tagName:payload.tag,isDraft:false,isPrerelease:false}]);
    if(args[0]==='api')return JSON.stringify({assets:[{name:model.RECORD}]});
    if(args[0]==='release' && args[1]==='download'){
      fs.writeFileSync(path.join(args[args.indexOf('--dir')+1],model.RECORD),JSON.stringify(payload));return '';
    }
    assert.fail('Unexpected baseline request');
  };
  const update={id:99,version:'0.1.0',approve:true,listed:true,hidden:false,channel:''};
  const input={host:'intellij',repository:'owner/repo',gh};
  assert.equal(baselines.discover({...input,publicUpdates:()=>[update]}).commit,r.base);
  for(const change of [{approve:false},{listed:false},{hidden:true},{channel:'beta'},{id:100},{version:'0.2.0'}])
    assert.throws(()=>baselines.discover({...input,publicUpdates:()=>[{...update,...change}]}), /No completed publication record/);
  assert.throws(()=>baselines.discover({...input,publicUpdates:()=>({})}), /verify public Marketplace/);
});
test('normal PRs allow unchanged released versions, tag reruns allow existing tags, and stale notes fail release validation', t => {
  const r = repository(t); r.setup(); const prepared = r.commit('Prepare coordinated release');
  r.git(['tag','v1.0.2',prepared]); r.git(['tag','intellij-v0.1.1',prepared]); r.git(['tag','cli-v0.1.1',prepared]);
  assert.doesNotThrow(() => validateTree(r.root,{release:true}));
  r.write('hprof-analyzer/src/lib.rs','later'); r.commit('Improve a later product feature');
  assert.doesNotThrow(() => validateTree(r.root,{base:prepared}));
  assert.throws(() => validateTree(r.root,{release:true}), /Product code changed/);
});
test('consistency, rollback, provenance and generic-note markers fail closed', t => {
  const r = repository(t);
  r.write('hprof-analyzer/src/lib.rs','fixed'); r.commit('fix'); r.setup();
  assert.throws(() => validateTree(r.root), /requires review/);
  const plan = JSON.parse(r.read(model.PLAN));
  for (const section of Object.values(plan.notes)) for (const entry of section.entries) entry.title='Correct graph reference resolution';
  r.write(model.PLAN,JSON.stringify(plan));
  refreshNotes(r.root);
  assert.doesNotThrow(() => validateTree(r.root));
  const lock = JSON.parse(r.read('package-lock.json')); lock.version='0.0.0'; r.write('package-lock.json',JSON.stringify(lock));
  assert.throws(() => validateTree(r.root), /lockfile versions differ/);
});
test('mismatched lockfiles, fabricated notes and product edits after preparation block the release', t => {
  const r=repository(t);r.write('hprof-analyzer/src/lib.rs','faster');r.commit('Improve shared graph loading');r.setup();
  const prepared=r.commit('Prepare coordinated release');
  assert.doesNotThrow(()=>validateTree(r.root,{base:r.base,release:true}));
  const plan=JSON.parse(r.read(model.PLAN));
  plan.notes.vscode.entries[0].sha='d'.repeat(40);
  r.write(model.PLAN,JSON.stringify(plan));
  const start=r.read('CHANGELOG.md').search(/^## /m), after=r.read('CHANGELOG.md').indexOf('## [1.0.1]');
  r.write('CHANGELOG.md',r.read('CHANGELOG.md').slice(0,start)+notes.changelog(plan)+'\n'+r.read('CHANGELOG.md').slice(after));
  assert.throws(()=>validateTree(r.root,{release:true}),/invented release-note provenance/);
  r.write(model.PLAN,r.git(['show',`${prepared}:${model.PLAN}`]));
  r.write('CHANGELOG.md',r.git(['show',`${prepared}:CHANGELOG.md`]));
  r.write('hprof-analyzer/Cargo.lock',r.read('hprof-analyzer/Cargo.lock').replace('version = "0.1.1"','version = "0.1.0"'));
  assert.throws(()=>validateTree(r.root),/Cargo lockfile versions differ/);
});
function tagFixture(t) {
  const r = repository(t); r.setup(); const sha = r.commit('Prepare coordinated release');
  const calls = [];
  const git = args => {
    calls.push(args);
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse' && args.includes('FETCH_HEAD^{commit}')) return r.git(['rev-parse','HEAD']);
    if (args[0] === 'ls-remote') return '';
    if (args[0] === 'remote') return 'https://github.com/owner/repo.git';
    if (args[0] === 'push') return '';
    return r.git(args);
  };
  const run = {id:7,head_sha:sha,event:'push',head_branch:'main',path:'.github/workflows/ci.yml',status:'completed',conclusion:'success'};
  const jobs = [{name:'checks',status:'completed',conclusion:'success'}];
  const gh = args => args.join(' ').includes('/jobs?') ? JSON.stringify([{jobs}]) : JSON.stringify({workflow_runs:[run]});
  return {r,sha,calls,git,gh,run,jobs};
}
test('tag command defaults to preflight and opt-in pushes all tags at one exact SHA atomically without local tags', t => {
  const f = tagFixture(t);
  assert.equal(tagRelease({root:f.r.root,sha:f.sha,git:f.git,gh:f.gh}).pushed,false);
  assert.equal(f.calls.some(args=>args[0]==='push'),false);
  assert.deepEqual(f.calls[0],['fetch','--no-tags','origin','refs/heads/main']);
  const result = tagRelease({root:f.r.root,sha:f.sha,git:f.git,gh:f.gh,execute:true});
  assert.deepEqual(result.tags,['v1.0.2','intellij-v0.1.1','cli-v0.1.1']);
  assert.deepEqual(f.calls.find(args=>args[0]==='push'),['push','--atomic','origin',...result.tags.map(tag=>`${f.sha}:refs/tags/${tag}`)]);
  assert.equal(f.r.git(['tag','--list']),'');
});
test('tag preflight rejects PR runs, another SHA, failed latest attempts, skipped checks, unsafe ancestry and existing tags', t => {
  const f = tagFixture(t);
  for (const change of [{event:'pull_request'},{head_sha:'b'.repeat(40)},{path:'.github/workflows/other.yml'},{conclusion:'failure'},{status:'in_progress'}])
    assert.throws(() => successfulRun([{...f.run,...change}],()=>f.jobs,f.sha), /successful main push run/);
  assert.throws(() => successfulRun([f.run,{...f.run,id:8,conclusion:'failure'}],()=>f.jobs,f.sha), /successful main push run/);
  assert.throws(() => successfulRun([f.run],()=>[{...f.jobs[0],conclusion:'skipped'}],f.sha), /aggregate checks/);
  const moved = args => args[0] === 'rev-parse' && args.includes('FETCH_HEAD^{commit}') ? f.r.base : f.git(args);
  assert.throws(() => tagRelease({root:f.r.root,sha:f.sha,git:moved,gh:f.gh}), /not on/);
  const existing = args => args[0] === 'ls-remote' && args.includes('--tags') ? `${f.sha}\trefs/tags/v1.0.2` : f.git(args);
  assert.throws(() => tagRelease({root:f.r.root,sha:f.sha,git:existing,gh:f.gh}), /already exists/);
  const newer = args => args[0] === 'ls-remote' && args.includes('--tags') ? `${f.sha}\trefs/tags/v9.0.0` : f.git(args);
  assert.throws(() => tagRelease({root:f.r.root,sha:f.sha,git:newer,gh:f.gh}), /does not exceed remote tags/);
  assert.equal(f.calls.some(args=>args[0]==='push'),false);
});
test('skip-CI traffic and documentation commits may follow the exact tested release without changing its tags', t => {
  const f=tagFixture(t);
  f.r.write('traffic/views-history.csv','date,total\n2026-10-17,1\n');f.r.commit('chore(traffic): daily snapshot [skip ci]');
  f.r.write('docs/guide.md','Documentation update');const tip=f.r.commit('Refresh user documentation');
  const result=tagRelease({root:f.r.root,sha:f.sha,git:f.git,gh:f.gh});
  assert.equal(result.sha,f.sha);assert.equal(result.main,tip);
  assert.deepEqual(new Set(result.following),new Set(['traffic/views-history.csv','docs/guide.md']));
  assert.equal(result.run,f.run.id,'CI belongs to the release SHA, not the untested traffic tip');
  assert.equal(f.calls.some(args=>args[0]==='push'),false);
});
test('code, manifest, workflow and unknown changes after a tested release cannot bypass the CI requirement', t => {
  for(const file of ['src/editor.ts','package.json','package-lock.json','hprof-analyzer/Cargo.toml','intellij-plugin/build.gradle.kts',
    'scripts/ci/prepare-release.cjs','.github/workflows/ci.yml','.vscodeignore','unknown/file'])assert.equal(followsRelease(file),false,file);
  const f=tagFixture(t);
  f.r.write('src/editor.ts','untested');f.r.write('.github/workflows/ci.yml','untested release workflow');
  f.r.commit('Change product code and release behavior');
  assert.throws(()=>tagRelease({root:f.r.root,sha:f.sha,git:f.git,gh:f.gh}),/Release-critical changes follow/);
  assert.equal(f.calls.some(args=>args[0]==='push'),false);
});
