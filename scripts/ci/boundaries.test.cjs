const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '../..');
const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
const jobs = workflow.jobs;
const runs = job => job.steps.filter(step => step.run).map(step => step.run).join('\n');

test('release selection is explicit, and all required checks precede versioning', () => {
  assert.ok(jobs.changes, 'CI needs a changed-path routing job');
  assert.deepEqual(jobs['auto-version'].needs, ['changes', 'checks']);
  assert.match(jobs['auto-version'].if, /needs\.changes\.outputs\.auto_release == 'true'/);
  assert.match(runs(jobs['auto-version']), /git push --atomic/);
  assert.doesNotMatch(runs(jobs['auto-version']), /--force/);
});

test('stable aggregate gate handles skipped host jobs without hiding failures', () => {
  assert.ok(jobs.checks, 'CI needs a stable aggregate check');
  assert.deepEqual(jobs.checks.needs, ['changes', 'boundary-tests', 'lint', 'test-rust', 'test-intellij']);
  assert.equal(jobs.checks.if, '${{ always() }}');
  assert.match(runs(jobs.checks), /scripts\/ci\/check-results\.cjs/);
});

test('first IntelliJ candidate uses Apple Silicon and tests the exact bundled package',()=>{
  const job=jobs['test-intellij'];
  assert.match(job.if,/needs\.changes\.outputs\.intellij == 'true'/);
  assert.equal(job['runs-on'],'macos-14');
  assert.equal(job.env.DO_NOT_TRACK,'1');
  assert.match(runs(job),/process\.platform.*process\.arch/);
  assert.match(runs(job),/extract-built-package\.cjs/);
  assert.match(runs(job),/heaplens\.test\.server=.*PLUGIN_ROOT\/native\/darwin-arm64/);
  assert.match(runs(job),/heaplens\.test\.pluginRoot=/);
  assert.match(runs(job),/heaplens\.test\.ci=true/);
  assert.match(runs(job),/test verifyPlugin/);
  assert.ok(job.steps.some(step=>step.uses?.startsWith('actions/upload-artifact@') && step.with.name==='intellij-apple-silicon-candidate'));
  assert.doesNotMatch(runs(job),/publishPlugin|git push|git tag/);
  assert.equal(jobs['build-intellij-native'],undefined);
  assert.equal(jobs['build-intellij-universal'],undefined);
});

test('macOS ARM64 delivery is declared in metadata, not inferred from the ZIP filename',()=>{
  const descriptor=fs.readFileSync(path.join(root,'intellij-plugin/src/main/resources/META-INF/plugin.xml'),'utf8');
  assert.match(descriptor,/<dependencies>\s*<plugin id="com\.intellij\.modules\.os\.mac"\/>\s*<plugin id="com\.intellij\.modules\.arch\.arm64"\/>\s*<\/dependencies>/);
  const build=fs.readFileSync(path.join(root,'intellij-plugin/build.gradle.kts'),'utf8');
  assert.match(build,/sinceBuild = "261"/);
  assert.match(build,/require\(serverTarget\.get\(\) == "darwin-arm64"\)/);
  assert.match(build,/freeArgs = listOf\("-ignore-os-arch"\)/);
  for(const gate of ['COMPATIBILITY_PROBLEMS','INTERNAL_API_USAGES','OVERRIDE_ONLY_API_USAGES','NON_EXTENDABLE_API_USAGES','MISSING_DEPENDENCIES','INVALID_PLUGIN'])
    assert.match(build,new RegExp('FailureLevel\\.'+gate));
  assert.doesNotMatch(build,/ignoredProblemsFile|externalPrefixes|FailureLevel\.NONE/);
});

test('IntelliJ CI tests the real engine using a generated, non-private fixture', () => {
  const job = jobs['test-intellij'];
  assert.ok(job, 'IntelliJ tests must run in CI');
  assert.match(job.if, /needs\.changes\.outputs\.intellij == 'true'/);
  assert.match(runs(job), /ClassRetainedCounterexample/);
  assert.match(runs(job), /cargo build --release --bin hprof-server/);
  assert.match(runs(job), /heaplens\.test\.ci=true/);
  assert.match(runs(job), /heaplens\.test\.server=/);
  assert.match(runs(job), /heaplens\.test\.dump=/);
  assert.doesNotMatch(runs(job), /\/Users\/|publishPlugin/);
  assert.ok(job.steps.some(step => step.uses?.startsWith('actions/setup-java@') && String(step.with['java-version']) === '21'));
});

test('VSIX build and publication use the selected VS Code path and aggregate gate', () => {
  assert.deepEqual(jobs.build.needs, ['changes', 'checks']);
  assert.match(jobs.build.if, /needs\.changes\.outputs\.vscode == 'true'/);
  assert.match(jobs.build.if, /needs\.checks\.result == 'success'/);
  assert.deepEqual(jobs.publish.needs, ['changes', 'checks', 'build']);
  assert.match(jobs.publish.if, /needs\.changes\.outputs\.publish_vscode == 'true'/);
  assert.match(jobs.publish.if, /needs\.build\.result == 'success'/);
  assert.doesNotMatch(JSON.stringify(workflow), /publishPlugin|JETBRAINS_MARKETPLACE_TOKEN/);
});

test('VS Code compiler roots and package exclusions enforce host isolation', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
  assert.deepEqual(config.include, ['src/**/*.ts']);
  assert.ok(config.exclude.includes('intellij-plugin'));
  assert.match(fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8'), /^intellij-plugin\/$/m);
  const ts = require('typescript');
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  assert.equal(parsed.errors.length, 0);
  assert.ok(parsed.fileNames.length > 0);
  assert.ok(parsed.fileNames.every(file => file.startsWith(path.join(root, 'src') + path.sep)));
});
