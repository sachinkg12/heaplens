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
