'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const common = require('./release-common.cjs');
const intellij = require('./release-intellij.cjs');
const cli = require('./release-cli.cjs');
const {homebrewFormula} = require('../distribution/homebrew.cjs');
const {pathToFileURL} = require('node:url');
const SHA = 'a'.repeat(40);
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-release-test-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true})); // Only this test-owned directory.
  return dir;
}
function write(dir, name, data) { fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive:true}); fs.writeFileSync(path.join(dir, name), data); }
function checksums(dir, names) { write(dir, 'SHA256SUMS', names.map(name => `${common.sha256(fs.readFileSync(path.join(dir, name)))}  ${name}\n`).join('')); }
function repository(t) {
  const cwd = temporary(t);
  const git = (...args) => execFileSync('git', args, {cwd, encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'release-test@example.invalid'); git('config', 'user.name', 'release test');
  write(cwd, 'README.md', 'base'); git('add', '-A'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feature'); write(cwd, 'feature.txt', 'unmerged'); git('add', '-A'); git('commit', '-qm', 'feature'); const unmerged = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  return {cwd, base, unmerged};
}
// A fake gh that records calls and serves a release state. Digests use the GitHub asset digest field.
function fakeGh(state = {}) {
  const calls = [];
  const gh = args => {
    calls.push(args);
    const [command, ...rest] = args;
    if (command === 'api' && /releases\/tags\//.test(rest[0])) {
      if (!state.release) { const error = new Error('gh: Not Found (HTTP 404)'); error.stderr = 'HTTP 404: Not Found'; throw error; }
      return JSON.stringify(state.release);
    }
    if (command === 'api' && /\/assets\?/.test(rest[0])) return JSON.stringify(state.assets || []);
    if (command === 'api' && /\/contents\//.test(rest[0]) && !rest.includes('--method')) {
      if (!state.tap) { const error = new Error('Not Found'); error.stderr = 'HTTP 404: Not Found'; throw error; }
      return JSON.stringify({sha:'tapsha', content: Buffer.from(state.tap).toString('base64')});
    }
    if (command === 'release' && rest[0] === 'download') {
      const dir = rest[rest.indexOf('--dir') + 1], pattern = rest[rest.indexOf('--pattern') + 1];
      if (!state.downloads || !state.downloads[pattern]) throw new Error('no such asset');
      fs.writeFileSync(path.join(dir, pattern), state.downloads[pattern]); return '';
    }
    return '';
  };
  return {gh, calls};
}
test('tags must be exact MAJOR.MINOR.PATCH with the host prefix', () => {
  assert.equal(common.tagVersion('refs/tags/intellij-v0.1.17', 'intellij-v'), '0.1.17');
  assert.equal(common.tagVersion('refs/tags/cli-v1.0.0', 'cli-v'), '1.0.0');
  for (const ref of ['refs/tags/intellij-v0.1.17-rc.1', 'refs/tags/intellij-v01.1.0', 'refs/tags/v0.1.17', 'refs/heads/main', '', undefined])
    assert.throws(() => common.tagVersion(ref, 'intellij-v'), /MAJOR\.MINOR\.PATCH/);
  assert.throws(() => common.tagVersion('refs/tags/intellij-v0.1.17', 'cli-v'));
});
test('only commits merged into the base branch can be released', t => {
  const r = repository(t);
  assert.doesNotThrow(() => common.requireAncestry(r.base, 'main', r.cwd));
  assert.throws(() => common.requireAncestry(r.unmerged, 'main', r.cwd), /not on main/);
  assert.throws(() => common.requireAncestry('not-a-sha', 'main', r.cwd), /Invalid release commit/);
  assert.throws(() => common.requireAncestry(r.base, '--output=x', r.cwd), /Invalid base reference/);
});
test('checksum files bind every asset and reject traversal, symlinks and mismatches', t => {
  const dir = temporary(t);
  write(dir, 'a.zip', 'alpha'); write(dir, 'b.txt', 'beta'); checksums(dir, ['a.zip', 'b.txt']);
  assert.deepEqual(Object.keys(common.readChecksums(dir)), ['a.zip', 'b.txt']);
  write(dir, 'b.txt', 'changed');
  assert.throws(() => common.readChecksums(dir), /Checksum mismatch: b\.txt/);
  write(dir, 'SHA256SUMS', `${'0'.repeat(64)}  ../escape\n`);
  assert.throws(() => common.readChecksums(dir), /Invalid checksum entry/);
  write(dir, 'SHA256SUMS', '');
  assert.throws(() => common.readChecksums(dir), /Empty checksum file/);
  fs.symlinkSync(path.join(dir, 'a.zip'), path.join(dir, 'link.zip'));
  write(dir, 'SHA256SUMS', `${common.sha256('alpha')}  link.zip\n`);
  assert.throws(() => common.readChecksums(dir), /regular file/);
});
test('GitHub releases are created once, completed on reruns and refuse conflicting assets', t => {
  const dir = temporary(t);
  write(dir, 'a.zip', 'alpha'); write(dir, 'SHA256SUMS', `${common.sha256('alpha')}  a.zip\n`);
  const sums = common.readChecksums(dir);
  const base = {repository:'owner/repo', tag:'intellij-v0.1.17', directory: dir, assets:['a.zip', 'SHA256SUMS'], sums, notes:'notes', log(){}};
  let fake = fakeGh();
  assert.equal(common.ensureRelease({...base, gh: fake.gh}), 'created');
  const create = fake.calls.find(args => args[0] === 'release' && args[1] === 'create');
  assert.ok(create.includes('--verify-tag') && create.includes(path.join(dir, 'a.zip')) && create.includes(path.join(dir, 'SHA256SUMS')));
  assert.doesNotMatch(create.join(' '), /--draft|--prerelease/);
  fake = fakeGh({release:{id:7, draft:false}, assets:[{name:'a.zip', digest:'sha256:' + sums['a.zip']}, {name:'SHA256SUMS', digest:'sha256:' + common.sha256(fs.readFileSync(path.join(dir, 'SHA256SUMS')))}]});
  assert.equal(common.ensureRelease({...base, gh: fake.gh}), 'unchanged');
  assert.ok(!fake.calls.some(args => args[0] === 'release'));
  fake = fakeGh({release:{id:7, draft:false}, assets:[{name:'a.zip', digest:'sha256:' + sums['a.zip']}]});
  assert.equal(common.ensureRelease({...base, gh: fake.gh}), 'completed');
  const upload = fake.calls.find(args => args[0] === 'release' && args[1] === 'upload');
  assert.ok(upload.includes(path.join(dir, 'SHA256SUMS')) && !upload.includes(path.join(dir, 'a.zip')));
  fake = fakeGh({release:{id:7, draft:false}, assets:[{name:'a.zip', digest:'sha256:' + 'f'.repeat(64)}]});
  assert.throws(() => common.ensureRelease({...base, gh: fake.gh}), /differs from the verified candidate/);
  fake = fakeGh({release:{id:7, draft:false}, assets:[{name:'a.zip', digest:null}], downloads:{'a.zip':'alpha'}});
  assert.equal(common.ensureRelease({...base, gh: fake.gh}), 'completed');
  fake = fakeGh({release:{id:7, draft:true}, assets:[]});
  assert.throws(() => common.ensureRelease({...base, gh: fake.gh}), /draft/);
  assert.throws(() => common.ensureRelease({...base, gh: fakeGh().gh, assets:['missing.bin']}), /not checksummed/);
});
function zipCandidate(t, version, {descriptorVersion = version, jarVersion = version} = {}) {
  const dir = temporary(t), stage = temporary(t);
  const descriptor = `<idea-plugin><id>${intellij.XML_ID}</id><version>${descriptorVersion}</version></idea-plugin>`;
  write(stage, 'META-INF/plugin.xml', descriptor);
  const jar = path.join(stage, 'plugin.jar');
  execFileSync('zip', ['-qr', jar, 'META-INF'], {cwd: stage});
  const tree = temporary(t);
  write(tree, `heaplens-intellij/lib/heaplens-intellij-${jarVersion}.jar`, fs.readFileSync(jar));
  write(tree, 'heaplens-intellij/native/darwin-arm64/hprof-server', 'binary');
  const name = `heaplens-intellij-${version}-darwin-arm64.zip`;
  execFileSync('zip', ['-qr', path.join(dir, name), 'heaplens-intellij'], {cwd: tree});
  checksums(dir, [name]);
  return {dir, name};
}
function intellijEnvironment(t, version = '0.1.17', candidate = zipCandidate(t, version)) {
  const r = repository(t);
  write(r.cwd, 'intellij-plugin/build.gradle.kts', `group = "com.heaplens"\nversion = "${version}"\n`);
  return {env:{GITHUB_REF:'refs/tags/intellij-v' + version, GITHUB_SHA: r.base, GITHUB_WORKSPACE: r.cwd, GITHUB_REPOSITORY:'owner/repo',
    ARTIFACT_DIR: candidate.dir, JETBRAINS_MARKETPLACE_TOKEN:'secret-token', RELEASE_BASE:'main'}, candidate, r};
}
function marketplace({updates = [], uploadResponse = {id: 99}} = {}) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    if (/\/updates\?/.test(url)) return {ok:true, status:200, json: async () => updates};
    if (/\/updates\/upload$/.test(url)) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer secret-token');
      assert.equal(options.body.get('xmlId'), intellij.XML_ID);
      assert.ok(options.body.get('file') instanceof Blob);
      return {ok:true, status:200, json: async () => uploadResponse};
    }
    throw new Error('unexpected request ' + url);
  };
  return {fetchImpl, requests};
}
test('IntelliJ release uploads the exact verified ZIP once and records a receipt', async t => {
  const {env, candidate} = intellijEnvironment(t);
  const market = marketplace();
  const fake = fakeGh();
  const log = [];
  assert.equal(await intellij.release(env, {fetchImpl: market.fetchImpl, gh: fake.gh, log: line => log.push(line)}), 'uploaded');
  assert.ok(market.requests.some(request => /upload$/.test(request.url)));
  const receipt = JSON.parse(fs.readFileSync(path.join(candidate.dir, intellij.RECEIPT), 'utf8'));
  assert.equal(receipt.update_id, 99); assert.equal(receipt.file, candidate.name); assert.equal(receipt.version, '0.1.17');
  assert.ok(fake.calls.some(args => args[0] === 'release' && args[1] === 'upload' && args.includes(path.join(candidate.dir, intellij.RECEIPT))));
  assert.ok(!log.join('\n').includes('secret-token'));
});
test('IntelliJ reruns skip Marketplace only with a matching receipt and otherwise stop for a person', async t => {
  const {env, candidate} = intellijEnvironment(t);
  const sums = common.readChecksums(candidate.dir);
  const listed = [{id: 99, version:'0.1.17', file:'35004/99/' + candidate.name, size: 1}];
  const release = {id: 3, draft:false};
  const assets = [{name: candidate.name, digest:'sha256:' + sums[candidate.name]}, {name:'SHA256SUMS', digest:'sha256:' + common.sha256(fs.readFileSync(path.join(candidate.dir, 'SHA256SUMS')))}];
  const receipt = JSON.stringify({version:'0.1.17', sha256: sums[candidate.name], update_id: 99});
  let fake = fakeGh({release, assets, downloads:{[intellij.RECEIPT]: receipt}});
  let market = marketplace({updates: listed});
  assert.equal(await intellij.release(env, {fetchImpl: market.fetchImpl, gh: fake.gh, log(){}}), 'unchanged');
  assert.ok(!market.requests.some(request => /upload$/.test(request.url)));
  fake = fakeGh({release, assets});
  market = marketplace({updates: listed});
  await assert.rejects(intellij.release(env, {fetchImpl: market.fetchImpl, gh: fake.gh, log(){}}), /without a matching upload receipt/);
  fake = fakeGh({release, assets, downloads:{[intellij.RECEIPT]: JSON.stringify({version:'0.1.17', sha256: sums[candidate.name], update_id: 42})}});
  market = marketplace({updates: listed});
  await assert.rejects(intellij.release(env, {fetchImpl: market.fetchImpl, gh: fake.gh, log(){}}), /without a matching upload receipt/);
});
test('IntelliJ release refuses unmerged commits, mismatched versions and foreign archives', async t => {
  const base = intellijEnvironment(t);
  const market = marketplace();
  await assert.rejects(intellij.release({...base.env, GITHUB_SHA: base.r.unmerged}, {fetchImpl: market.fetchImpl, gh: fakeGh().gh, log(){}}), /not on main/);
  await assert.rejects(intellij.release({...base.env, GITHUB_REF:'refs/tags/intellij-v0.1.18'}, {fetchImpl: market.fetchImpl, gh: fakeGh().gh, log(){}}), /Gradle plugin version/);
  const wrongDescriptor = zipCandidate(t, '0.1.17', {descriptorVersion:'0.1.16'});
  await assert.rejects(intellij.release({...base.env, ARTIFACT_DIR: wrongDescriptor.dir}, {fetchImpl: market.fetchImpl, gh: fakeGh().gh, log(){}}), /Descriptor version/);
  const wrongJar = zipCandidate(t, '0.1.17', {jarVersion:'0.1.16'});
  await assert.rejects(intellij.release({...base.env, ARTIFACT_DIR: wrongJar.dir}, {fetchImpl: market.fetchImpl, gh: fakeGh().gh, log(){}}), /must contain exactly/);
  write(base.candidate.dir, base.candidate.name, 'tampered after checksum');
  await assert.rejects(intellij.release(base.env, {fetchImpl: market.fetchImpl, gh: fakeGh().gh, log(){}}), /Checksum mismatch/);
  await assert.rejects(intellij.release({...base.env, JETBRAINS_MARKETPLACE_TOKEN:''}, {fetchImpl: market.fetchImpl, gh: fakeGh().gh, log(){}}));
  assert.ok(!market.requests.some(request => /upload$/.test(request.url)));
});
function cliCandidate(t, version, sha, overrides = {}) {
  const dir = temporary(t);
  const portable = `heaplens-cli-${version}-darwin-arm64.tar.gz`, npmArchive = `heaplens-cli-${version}.tgz`;
  write(dir, portable, 'portable ' + version); write(dir, npmArchive, 'npm ' + version);
  checksums(dir, [portable, npmArchive]);
  const sums = common.readChecksums(dir);
  const config = {schema_version:1, version, npm_name:'heaplens-cli', repository:'owner/repo', target:'darwin-arm64'};
  write(dir, 'homebrew/heaplens.rb', homebrewFormula(config, portable, sums[portable]));
  // The build runner's local formula points at a directory that does not exist where publication runs.
  write(dir, 'homebrew-local/heaplens.rb', homebrewFormula(config, portable, sums[portable], 'file:///Users/runner/work/_temp/heaplens-cli-candidate.AbC123/' + portable));
  write(dir, 'candidate.json', JSON.stringify({version, target:'darwin-arm64', npm_name:'heaplens-cli', portable_archive: portable, npm_archive: npmArchive,
    sha256: sums[portable], source_commit: sha, source_dirty:false, ...overrides}));
  return {dir, portable, npmArchive, sums, formula: fs.readFileSync(path.join(dir, 'homebrew/heaplens.rb'), 'utf8')};
}
function cliEnvironment(t, version = '0.1.1', overrides = {}) {
  const r = repository(t);
  write(r.cwd, 'scripts/distribution/config.json', JSON.stringify({schema_version:1, version, npm_name:'heaplens-cli', repository:'owner/repo', target:'darwin-arm64'}));
  write(r.cwd, 'hprof-analyzer/Cargo.toml', `[package]\nname = "hprof-analyzer"\nversion = "${version}"\n`);
  const candidate = cliCandidate(t, version, r.base, overrides);
  return {env:{GITHUB_REF:'refs/tags/cli-v' + version, GITHUB_SHA: r.base, GITHUB_WORKSPACE: r.cwd, GITHUB_REPOSITORY:'owner/repo',
    CANDIDATE_DIR: candidate.dir, HOMEBREW_TAP_TOKEN:'tap-token', TAP_REPOSITORY:'owner/homebrew-heaplens', RELEASE_BASE:'main'}, candidate, r};
}
function registry({published = null, downloadBody} = {}) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    if (/registry\.npmjs\.org/.test(url)) return published ? {ok:true, status:200, json: async () => published} : {ok:false, status:404};
    if (/releases\/download\//.test(url)) return {ok:true, status:200, arrayBuffer: async () => Buffer.from(downloadBody)};
    throw new Error('unexpected request ' + url);
  };
  return {fetchImpl, requests};
}
test('CLI release publishes the verified candidate in order and refuses to run without acceptance', async t => {
  const {env, candidate} = cliEnvironment(t);
  const net = registry({downloadBody:'portable 0.1.1'});
  const fake = fakeGh();
  const order = [], npmCalls = [], acceptance = [], formulas = {};
  const result = await cli.release(env, {fetchImpl: net.fetchImpl, gh: args => { order.push('gh:' + args.slice(0, 2).join(' ')); return fake.gh(args); },
    npm: args => { npmCalls.push(args); order.push('npm'); }, log(){},
    acceptance: ({label, formula}) => { acceptance.push(label); formulas[label] = formula; order.push('brew:' + label); }});
  assert.equal(result, 'published');
  assert.deepEqual(acceptance, ['heaplens-release-local', 'heaplens-release-public']);
  // Regression: the local acceptance must install the downloaded archive, not the build runner's vanished temp path.
  assert.ok(formulas['heaplens-release-local'].includes(`url "${pathToFileURL(path.join(candidate.dir, candidate.portable)).href}"`));
  assert.doesNotMatch(formulas['heaplens-release-local'], /heaplens-cli-candidate\.AbC123/);
  assert.equal(formulas['heaplens-release-public'], candidate.formula);
  assert.deepEqual(npmCalls, [['publish', path.join(candidate.dir, candidate.npmArchive), '--access', 'public', '--provenance']]);
  const index = name => order.findIndex(entry => entry.startsWith(name));
  assert.ok(index('brew:heaplens-release-local') < index('gh:release create'), 'local Homebrew acceptance precedes the release');
  assert.ok(index('gh:release create') < index('brew:heaplens-release-public'), 'public formula acceptance follows the release');
  assert.ok(index('brew:heaplens-release-public') < index('npm'), 'npm publication follows public acceptance');
  assert.ok(index('npm') < index('gh:api --method'), 'the tap updates last');
  const tapWrite = fake.calls.find(args => args.includes('--method'));
  assert.ok(tapWrite[3].startsWith('repos/owner/homebrew-heaplens/contents/Formula/heaplens.rb'));
  assert.ok(tapWrite.includes('content=' + Buffer.from(candidate.formula).toString('base64')));
});
test('CLI release binds the tag to the crate, config, candidate and tagged commit', async t => {
  const net = registry({downloadBody:'portable 0.1.1'});
  const quiet = {fetchImpl: net.fetchImpl, gh: fakeGh().gh, npm(){}, log(){}, acceptance(){}};
  let fixture = cliEnvironment(t);
  await assert.rejects(cli.release({...fixture.env, GITHUB_REF:'refs/tags/cli-v0.1.2'}, quiet), /does not match the candidate version/);
  fixture = cliEnvironment(t, '0.1.1', {source_dirty:true});
  await assert.rejects(cli.release(fixture.env, quiet), /dirty-worktree/);
  fixture = cliEnvironment(t, '0.1.1', {source_commit:'b'.repeat(40)});
  await assert.rejects(cli.release(fixture.env, quiet), /not the tagged commit/);
  fixture = cliEnvironment(t);
  write(fixture.r.cwd, 'hprof-analyzer/Cargo.toml', '[package]\nversion = "0.1.0"\n');
  await assert.rejects(cli.release(fixture.env, quiet), /analyzer crate version/);
  fixture = cliEnvironment(t);
  await assert.rejects(cli.release({...fixture.env, GITHUB_SHA: fixture.r.unmerged}, quiet), /not on main/);
  fixture = cliEnvironment(t);
  await assert.rejects(cli.release({...fixture.env, HOMEBREW_TAP_TOKEN:''}, quiet), /HOMEBREW_TAP_TOKEN/);
  fixture = cliEnvironment(t);
  const bad = registry({downloadBody:'something else'});
  await assert.rejects(cli.release(fixture.env, {...quiet, fetchImpl: bad.fetchImpl}), /does not match the verified archive/);
  fixture = cliEnvironment(t);
  write(fixture.candidate.dir, 'homebrew/heaplens.rb', fixture.candidate.formula.replace('depends_on "node"', 'depends_on "python"'));
  await assert.rejects(cli.release(fixture.env, quiet), /candidate formula does not match/);
});
test('npm and tap steps recognize matching publications and refuse different content', async t => {
  const dir = temporary(t); write(dir, 'pkg.tgz', 'npm bytes');
  const archive = path.join(dir, 'pkg.tgz');
  const same = registry({published:{dist:{integrity: cli.integrity(archive)}}});
  let npmCalls = 0;
  assert.equal(await cli.publishNpm({name:'heaplens-cli', version:'0.1.1', archive, fetchImpl: same.fetchImpl, npm:() => { npmCalls += 1; }, log(){}}), 'unchanged');
  assert.equal(npmCalls, 0);
  const different = registry({published:{dist:{integrity:'sha512-other'}}});
  await assert.rejects(cli.publishNpm({name:'heaplens-cli', version:'0.1.1', archive, fetchImpl: different.fetchImpl, npm:() => { npmCalls += 1; }, log(){}}), /different content/);
  assert.equal(npmCalls, 0);
  const formula = 'class Heaplens < Formula\n  version "0.1.1"\nend\n';
  assert.equal(cli.updateTap({tapRepository:'owner/homebrew-heaplens', formula, version:'0.1.1', gh: fakeGh({tap: formula}).gh, log(){}}), 'unchanged');
  assert.throws(() => cli.updateTap({tapRepository:'owner/homebrew-heaplens', formula, version:'0.1.1', gh: fakeGh({tap: formula.replace('end', '  # edited\nend')}).gh, log(){}}), /different formula for 0\.1\.1/);
  const older = fakeGh({tap: formula.replace('0.1.1', '0.1.0')});
  assert.equal(cli.updateTap({tapRepository:'owner/homebrew-heaplens', formula, version:'0.1.1', gh: older.gh, log(){}}), 'updated');
  assert.ok(older.calls.at(-1).includes('sha=tapsha'));
  // Regression: rerunning an older tag after a newer release must not downgrade the tap.
  for (const newer of ['0.2.0', '0.1.2', '1.0.0']) {
    const tap = fakeGh({tap: formula.replace('0.1.1', newer)});
    assert.throws(() => cli.updateTap({tapRepository:'owner/homebrew-heaplens', formula, version:'0.1.1', gh: tap.gh, log(){}}), /would downgrade/);
    assert.ok(!tap.calls.some(args => args.includes('--method')), 'no write on downgrade');
  }
  assert.equal(common.compareVersions('0.10.0', '0.9.9') > 0, true);
  assert.throws(() => common.compareVersions('0.1', '0.1.0'), /Not an exact version/);
  assert.throws(() => cli.updateTap({tapRepository:'owner/not-a-tap', formula, version:'0.1.1', gh: fakeGh().gh, log(){}}), /Invalid tap repository/);
});
test('Homebrew acceptance uses a disposable tap and always removes it', t => {
  const brewCalls = [];
  const brew = args => { brewCalls.push(args[0]); if (args[0] === 'test') throw new Error('formula test failed'); if (args[0] === '--prefix') return '/opt/homebrew\n'; return ''; };
  const git = (args, options) => execFileSync('git', args, {cwd: options.cwd, encoding:'utf8', stdio:['ignore','pipe','pipe']});
  assert.throws(() => cli.homebrewAcceptance({formula:'class Heaplens < Formula\nend\n', label:'heaplens-release-local', brew, git, log(){}}), /formula test failed/);
  assert.deepEqual(brewCalls, ['tap', 'install', 'test', 'uninstall', 'untap']);
  assert.throws(() => cli.homebrewAcceptance({formula:'', label:'Bad Label', brew, git, log(){}}), /Invalid tap label/);
});
