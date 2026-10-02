const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {planChanges} = require('./change-policy.cjs');
const {changedPaths} = require('./detect-changes.cjs');
const {checkResults} = require('./check-results.cjs');
const main = {eventName:'push',ref:'refs/heads/main',message:'fix: behavior'};
const expected = (vscode,intellij,rust,auto_release,publish_vscode=false) =>
  ({vscode,intellij,rust,auto_release,publish_vscode});

for (const [label,files,plan] of [
  ['IntelliJ Java', ['intellij-plugin/src/main/java/Editor.java'], expected(false,true,false,false)],
  ['IntelliJ build and docs', ['intellij-plugin/build.gradle.kts','intellij-plugin/README.md'], expected(false,true,false,false)],
  ['VS Code adapter', ['src/hprofEditorProvider.ts'], expected(true,false,false,true)],
  ['shared renderer', ['src/webview/js/query.ts'], expected(true,true,false,true)],
  ['shared engine', ['hprof-analyzer/src/main.rs'], expected(true,true,true,true)],
  ['shared npm tooling', ['package-lock.json'], expected(true,true,false,true)],
  ['VSIX packaging', ['.vscodeignore'], expected(true,false,false,true)],
  ['documentation only', ['README.md','docs-site/docs/overview.md'], expected(false,false,false,false)],
  ['CI policy', ['scripts/ci/change-policy.cjs','.github/workflows/ci.yml'], expected(true,true,true,false)],
  ['unknown path', ['new-component/source.code'], expected(true,true,true,false)],
  ['mixed hosts', ['src/extension.ts','intellij-plugin/src/main/webview/query-lifecycle.js'], expected(true,true,false,true)]
]) {
  test('routing: '+label, () => assert.deepEqual(planChanges(files,main), plan));
}
test('PRs, release commits and unrelated branches cannot auto-bump', () => {
  for (const event of [
    {...main,eventName:'pull_request'}, {...main,ref:'refs/heads/feature'},
    {...main,message:'chore(release): v1.0.32'}, {...main,eventName:'workflow_dispatch'}
  ]) assert.equal(planChanges(['src/extension.ts'],event).auto_release,false);
});
test('stable VS Code tags select every compatibility check and only VS Code publication', () => {
  assert.deepEqual(planChanges([],{...main,ref:'refs/tags/v1.0.32'}),expected(true,true,true,false,true));
});
test('IntelliJ tags validate without bumping or publishing VS Code', () => {
  assert.deepEqual(planChanges([],{...main,ref:'refs/tags/intellij-v0.1.0'}),expected(false,true,false,false));
});
test('unrecognized and prerelease tags never publish accidentally', () => {
  for (const ref of ['refs/tags/vnotes','refs/tags/v01.2.3','refs/tags/v1.0.32-beta.1'])
    assert.deepEqual(planChanges([],{...main,ref}),expected(true,true,true,false));
});
test('a shared file after 500 documentation paths still requires both hosts', () => {
  assert.deepEqual(planChanges([...Array.from({length:500},(_,i)=>'docs/page-'+i+'.md'),'src/webview/js/query.ts'],main),
    expected(true,true,false,true));
});
function passingNeeds(plan) {
  return {
    changes:{result:'success',outputs:{rust:String(plan.rust),intellij:String(plan.intellij)}},
    'boundary-tests':{result:'success'},lint:{result:'success'},
    'test-rust':{result:plan.rust?'success':'skipped'},
    'test-intellij':{result:plan.intellij?'success':'skipped'}
  };
}
test('aggregate gate accepts intentional skips but rejects every required failure, cancellation or skip', () => {
  for (const paths of [['src/extension.ts'],['intellij-plugin/build.gradle.kts'],['hprof-analyzer/src/main.rs'],['README.md']]) {
    const good=passingNeeds(planChanges(paths,main));
    assert.doesNotThrow(()=>checkResults(good));
    for (const job of Object.keys(good).filter(job=>good[job].result==='success')) {
      for (const result of ['failure','cancelled','skipped',undefined]) {
        const bad=structuredClone(good); bad[job].result=result;
        assert.throws(()=>checkResults(bad),undefined,job+' '+result);
      }
    }
  }
});
test('missing routing output fails closed', () => {
  const needs=passingNeeds(expected(false,false,false,false));
  delete needs.changes.outputs.intellij;
  assert.throws(()=>checkResults(needs),/Missing routing output/);
});

function repository(t) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'heaplens-ci-policy-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true})); // Only this test-owned temp repository.
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q'); git('config','user.email','ci-test@example.invalid'); git('config','user.name','CI test');
  const write=(file,value)=>{ const target=path.join(cwd,file); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,value); };
  const commit=()=>{git('add','-A');git('commit','-qm','test snapshot');return git('rev-parse','HEAD');};
  write('README.md','baseline'); const base=commit();
  return {cwd,git,write,commit,base};
}
test('real git diff handles a multi-commit push including deleted and renamed host paths', t => {
  const r=repository(t);
  r.write('src/old name.ts','value'); const before=r.commit();
  fs.mkdirSync(path.join(r.cwd,'intellij-plugin'));
  r.git('mv','src/old name.ts','intellij-plugin/new name.java'); r.commit();
  r.write('intellij-plugin/another.java','later commit'); const after=r.commit();
  const files=changedPaths('push',{before},after,r.cwd);
  assert.deepEqual(new Set(files),new Set(['src/old name.ts','intellij-plugin/new name.java','intellij-plugin/another.java']));
  assert.deepEqual(planChanges(files,main),expected(true,true,false,true));
});
test('PR diff uses merge-base and does not count changes made only on the base branch', t => {
  const r=repository(t);
  r.git('checkout','-qb','feature');
  r.write('intellij-plugin/Only.java','feature'); const head=r.commit();
  r.git('checkout','-qb','base-advanced',r.base);
  r.write('src/only-on-base.ts','base advanced'); const base=r.commit();
  assert.deepEqual(changedPaths('pull_request',{pull_request:{base:{sha:base},head:{sha:head}}},head,r.cwd),
    ['intellij-plugin/Only.java']);
});
test('first push enumerates tracked paths and malformed revisions cannot turn into git options', t => {
  const r=repository(t);
  assert.deepEqual(changedPaths('push',{before:'0'.repeat(40)},r.base,r.cwd),['README.md']);
  assert.throws(()=>changedPaths('push',{before:'--output=bad'},r.base,r.cwd),/invalid event revision/);
  assert.throws(()=>changedPaths('workflow_dispatch',{},r.base,r.cwd),/Unsupported/);
});
test('the workflow CLI emits false release outputs for a real IntelliJ-only push', t => {
  const r=repository(t); r.write('intellij-plugin/Test.java','prototype'); const head=r.commit();
  const payload=path.join(r.cwd,'event.json'), output=path.join(r.cwd,'outputs');
  fs.writeFileSync(payload,JSON.stringify({before:r.base,head_commit:{message:'prototype'}}));
  execFileSync(process.execPath,[path.join(__dirname,'detect-changes.cjs')],{
    cwd:r.cwd,env:{...process.env,GITHUB_EVENT_PATH:payload,GITHUB_OUTPUT:output,
      GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_SHA:head}
  });
  assert.match(fs.readFileSync(output,'utf8'),/^intellij=true$/m);
  assert.match(fs.readFileSync(output,'utf8'),/^auto_release=false$/m);
  assert.match(fs.readFileSync(output,'utf8'),/^publish_vscode=false$/m);
});
