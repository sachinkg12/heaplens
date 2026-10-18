'use strict';
// Publish the standalone CLI candidate that the candidate and installed-smoke jobs verified. Exact cli-vMAJOR.MINOR.PATCH tags only.
// Order: version binding -> local Homebrew acceptance -> GitHub release -> public download and public formula acceptance
//        -> npm (trusted publishing) -> Homebrew tap. Every step is idempotent and refuses conflicting artifacts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const common = require('./release-common.cjs');
const {hostNotes} = require('./release-publication-notes.cjs');
const {publishRecord} = require('./release-baselines.cjs');
const {homebrewFormula} = require('../distribution/homebrew.cjs');
const NPM_REGISTRY = 'https://registry.npmjs.org';
const FORMULA = 'Formula/heaplens.rb';
const integrity = file => 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
function bindVersions({root, directory, version, tag}) {
  const candidate = JSON.parse(fs.readFileSync(path.join(directory, 'candidate.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'scripts/distribution/config.json'), 'utf8'));
  const crate = common.declaredVersion(fs.readFileSync(path.join(root, 'hprof-analyzer/Cargo.toml'), 'utf8'), /^version = "([^"\n]+)"$/m, 'analyzer crate');
  for (const [label, value] of [['candidate', candidate.version], ['distribution config', config.version], ['analyzer crate', crate]])
    if (value !== version) throw new Error(`Tag ${tag} does not match the ${label} version ${value}`);
  if (candidate.target !== 'darwin-arm64' || config.target !== 'darwin-arm64') throw new Error('Unexpected candidate target');
  if (candidate.source_dirty !== false) throw new Error('A dirty-worktree candidate cannot be released');
  return {candidate, config};
}
function verifiedCandidate({root, directory, version, tag, sha}) {
  const {candidate, config} = bindVersions({root, directory, version, tag});
  if (candidate.source_commit !== sha) throw new Error(`Candidate was built from ${candidate.source_commit}, not the tagged commit`);
  const sums = common.readChecksums(directory);
  const portable = `heaplens-cli-${version}-darwin-arm64.tar.gz`, npmArchive = `heaplens-cli-${version}.tgz`;
  if (candidate.portable_archive !== portable || candidate.npm_archive !== npmArchive) throw new Error('Unexpected candidate file names');
  if (!sums[portable] || !sums[npmArchive] || sums[portable] !== candidate.sha256) throw new Error('Candidate checksums do not cover the release archives');
  // The public formula must be exactly what the generator produces for this release archive.
  const formula = homebrewFormula(config, portable, sums[portable]);
  if (fs.readFileSync(path.join(directory, 'homebrew/heaplens.rb'), 'utf8') !== formula) throw new Error('The candidate formula does not match this release archive');
  const expectedUrl = `https://github.com/${config.repository}/releases/download/${tag}/${portable}`;
  if (!formula.includes(`url "${expectedUrl}"`)) throw new Error('The public formula does not point at this release archive');
  // The build runner's local formula names a temp path that no longer exists; regenerate it for the downloaded archive.
  const localFormula = homebrewFormula(config, portable, sums[portable], pathToFileURL(path.join(directory, portable)).href);
  return {config, sums, portable, npmArchive, formula, localFormula, portableUrl: expectedUrl};
}
// Install one formula from a disposable local tap, run its test block and the CLI, then remove only that tap.
function homebrewAcceptance({formula, label, brew, git, log}) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid tap label');
  const tap = `sachinkg12/${label}`, fullName = `${tap}/heaplens`;
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-tap-'));
  try {
    fs.mkdirSync(path.join(repository, 'Formula'));
    fs.writeFileSync(path.join(repository, FORMULA), formula);
    git(['init', '-q'], {cwd: repository});
    git(['-c', 'user.name=release-check', '-c', 'user.email=release-check@invalid', 'add', '-A'], {cwd: repository});
    git(['-c', 'user.name=release-check', '-c', 'user.email=release-check@invalid', 'commit', '-qm', 'formula under test'], {cwd: repository});
    brew(['tap', tap, repository]);
    try {
      brew(['install', fullName]);
      brew(['test', fullName]);
      const prefix = brew(['--prefix']).trim();
      const help = common.run(path.join(prefix, 'bin/heaplens'), ['--help'], {env:{...process.env, DO_NOT_TRACK:'1'}});
      if (!/analyze/.test(help)) throw new Error('Installed heaplens --help is unexpected');
      log(`Homebrew acceptance passed for ${label}`);
    } finally {
      try { brew(['uninstall', '--force', fullName]); } catch {}
      brew(['untap', tap]); // Only the disposable tap created above.
    }
  } finally { fs.rmSync(repository, {recursive:true, force:true}); }
}
async function verifyPublicDownload({url, expected, fetchImpl, log}) {
  await common.retry(async () => {
    const response = await fetchImpl(url, {redirect:'follow'});
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const actual = common.sha256(Buffer.from(await response.arrayBuffer()));
    if (actual !== expected) throw new Error('Public release download does not match the verified archive');
  }, {log});
  log('Public release download matches the verified archive');
}
async function publishNpm({name, version, archive, fetchImpl, npm, log}) {
  const response = await fetchImpl(`${NPM_REGISTRY}/${encodeURIComponent(name)}/${version}`, {headers:{accept:'application/json'}});
  if (response.ok) {
    const published = await response.json();
    if (published && published.dist && published.dist.integrity === integrity(archive)) { log(`npm already has ${name}@${version} with matching integrity; publish skipped`); return 'unchanged'; }
    throw new Error(`npm already has ${name}@${version} with different content; resolve this manually`);
  }
  if (response.status !== 404) throw new Error('Cannot query the npm registry: HTTP ' + response.status);
  npm(['publish', archive, '--access', 'public', '--provenance']);
  log(`Published ${name}@${version} to npm`);
  return 'published';
}
function updateTap({tapRepository, formula, version, gh, log}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/homebrew-[A-Za-z0-9._-]+$/.test(tapRepository || '')) throw new Error('Invalid tap repository');
  const endpoint = `repos/${tapRepository}/contents/${FORMULA}`;
  let existing = null;
  try { existing = JSON.parse(gh(['api', endpoint])); }
  catch (error) { if (!/404|Not Found/i.test(String(error.stderr || error.message))) throw error; }
  if (existing) {
    const current = Buffer.from(existing.content || '', 'base64').toString('utf8');
    if (current === formula) { log('Homebrew tap already serves this formula'); return 'unchanged'; }
    const currentVersion = common.declaredVersion(current, /^  version "([^"\n]+)"$/m, 'tap formula');
    const order = common.compareVersions(currentVersion, version);
    if (order === 0) throw new Error(`The tap already has a different formula for ${version}; resolve this manually`);
    if (order > 0) throw new Error(`The tap serves ${currentVersion}; rerunning ${version} would downgrade it, so nothing was written`);
  }
  gh(['api', '--method', 'PUT', endpoint, '-f', `message=heaplens ${version}`, '-f', `content=${Buffer.from(formula).toString('base64')}`,
    ...(existing ? ['-f', `sha=${existing.sha}`] : [])]);
  log(`Updated ${tapRepository}/${FORMULA} to ${version}`);
  return 'updated';
}
async function release(env, {fetchImpl = fetch, gh, git, brew, npm, log = console.log, acceptance = homebrewAcceptance} = {}) {
  gh ||= (args, options) => common.run('gh', args, options);
  git ||= (args, options) => common.run('git', args, options);
  brew ||= (args, options) => common.run('brew', args, {env:{...process.env, HOMEBREW_NO_AUTO_UPDATE:'1', HOMEBREW_NO_INSTALL_CLEANUP:'1'}, ...options});
  npm ||= (args, options) => common.run('npm', args, {stdio:['ignore', 'inherit', 'inherit'], ...options});
  const version = common.tagVersion(env.GITHUB_REF, 'cli-v');
  const tag = 'cli-v' + version;
  const sha = common.commitSha(env.GITHUB_SHA);
  const root = env.GITHUB_WORKSPACE || process.cwd();
  common.requireAncestry(sha, env.RELEASE_BASE || 'origin/main', root, git);
  const directory = env.CANDIDATE_DIR;
  const {config, sums, portable, npmArchive, formula, localFormula, portableUrl} = verifiedCandidate({root, directory, version, tag, sha});
  if (config.repository !== env.GITHUB_REPOSITORY) throw new Error('Candidate repository does not match the workflow repository');
  if (!env.HOMEBREW_TAP_TOKEN) throw new Error('HOMEBREW_TAP_TOKEN is not configured');
  acceptance({formula: localFormula, label:'heaplens-release-local', brew, git, log});
  const notes = common.releaseNotes({tag, sha, sums, lines:[
    hostNotes(root, 'cli', version),
    `Standalone CLI ${version} for macOS Apple Silicon (Node.js 22 or newer for the browser host). CLI versions are independent of VS Code and IntelliJ versions.`,
    `Install: \`npm install -g ${config.npm_name}@${version}\` or \`brew install sachinkg12/heaplens/heaplens\`.`]});
  common.ensureRelease({repository: env.GITHUB_REPOSITORY, tag, directory, assets:[portable, npmArchive, 'SHA256SUMS'], sums, notes, gh, log});
  await verifyPublicDownload({url: portableUrl, expected: sums[portable], fetchImpl, log});
  acceptance({formula, label:'heaplens-release-public', brew, git, log});
  await publishNpm({name: config.npm_name, version, archive: path.join(directory, npmArchive), fetchImpl, npm, log});
  updateTap({tapRepository: env.TAP_REPOSITORY || 'sachinkg12/homebrew-heaplens', formula, version, log,
    gh: (args, options) => gh(args, {env:{...process.env, GH_TOKEN: env.HOMEBREW_TAP_TOKEN}, ...options})});
  publishRecord({host:'cli', version, commit:sha, repository:env.GITHUB_REPOSITORY, directory, gh});
  return 'published';
}
if (require.main === module) {
  release(process.env).then(result => console.log('CLI release: ' + result)).catch(error => {
    console.error('CLI release stopped: ' + error.message);
    process.exitCode = 1;
  });
}
module.exports = {release, verifiedCandidate, homebrewAcceptance, publishNpm, updateTap, integrity};
