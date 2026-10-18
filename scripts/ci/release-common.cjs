'use strict';
// Shared release checks: exact tag syntax, main ancestry, checksum binding and idempotent GitHub releases.
// Nothing here rebuilds an artifact; publication always uses the files the test jobs produced.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const SEMVER = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function run(command, args, options = {}) {
  return execFileSync(command, args, {encoding:'utf8', stdio:['ignore','pipe','pipe'], maxBuffer:16 * 1024 * 1024, ...options});
}
function tagVersion(ref, prefix) {
  const match = new RegExp('^refs/tags/' + prefix + SEMVER + '$').exec(ref || '');
  if (!match) throw new Error(`Release tags must be ${prefix}MAJOR.MINOR.PATCH`);
  return match[0].slice('refs/tags/'.length + prefix.length);
}
function commitSha(value) {
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw new Error('Invalid release commit');
  return value;
}
// Only commits already merged into the release branch may be published.
function requireAncestry(sha, base, cwd, git = (args, options) => run('git', args, options)) {
  commitSha(sha);
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(base || '')) throw new Error('Invalid base reference');
  try { git(['merge-base', '--is-ancestor', sha, base], {cwd}); }
  catch { throw new Error(`Release commit ${sha} is not on ${base}; only merged commits can be released`); }
}
// Exact MAJOR.MINOR.PATCH comparison: negative, zero or positive like a comparator.
function compareVersions(left, right) {
  const parse = value => { const match = new RegExp('^' + SEMVER + '$').exec(value || ''); if (!match) throw new Error('Not an exact version: ' + value); return match.slice(1).map(Number); };
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}
function declaredVersion(source, pattern, label) {
  const match = pattern.exec(source);
  if (!match) throw new Error('Cannot find the ' + label + ' version');
  return match[1];
}
// Every published asset must appear in SHA256SUMS and match it byte for byte.
function readChecksums(directory, file = 'SHA256SUMS') {
  const sums = {};
  for (const line of fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64})  ([^\s\/\\]+)$/.exec(line);
    if (!match || match[2] === '.' || match[2] === '..' || sums[match[2]]) throw new Error('Invalid checksum entry');
    const [, expected, name] = match;
    const target = path.join(directory, name);
    if (!fs.lstatSync(target).isFile()) throw new Error('Checksummed entry must be a regular file: ' + name);
    if (sha256(fs.readFileSync(target)) !== expected) throw new Error('Checksum mismatch: ' + name);
    sums[name] = expected;
  }
  if (!Object.keys(sums).length) throw new Error('Empty checksum file');
  return sums;
}
function releaseNotes({tag, sha, sums, lines = []}) {
  return [`Release ${tag} built from commit ${sha}.`, '', ...lines, '', 'SHA-256 of the attached files:', '',
    ...Object.entries(sums).map(([name, digest]) => `- \`${name}\`: \`${digest}\``), ''].join('\n');
}
function assetDigest({repository, tag, asset, gh}) {
  if (asset.digest) return String(asset.digest).replace(/^sha256:/, '');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-release-asset-'));
  try {
    gh(['release', 'download', tag, '--repo', repository, '--pattern', asset.name, '--dir', temporary]);
    return sha256(fs.readFileSync(path.join(temporary, asset.name)));
  } finally { fs.rmSync(temporary, {recursive:true, force:true}); } // Only this verification download.
}
// Create the release once. A rerun accepts only assets whose bytes match and adds the missing ones.
function ensureRelease({repository, tag, directory, assets, sums, notes, gh = (args, options) => run('gh', args, options), log = console.log}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository || '')) throw new Error('Invalid repository');
  // The checksum file itself is published too; its digest is taken from the verified bytes on disk.
  const expected = {...sums};
  for (const name of assets) {
    if (expected[name]) continue;
    if (name !== 'SHA256SUMS') throw new Error('Release asset is not checksummed: ' + name);
    expected[name] = sha256(fs.readFileSync(path.join(directory, name)));
  }
  const files = assets.map(name => path.join(directory, name));
  let release = null;
  try { release = JSON.parse(gh(['api', `repos/${repository}/releases/tags/${tag}`])); }
  catch (error) { if (!/404|Not Found/i.test(String(error.stderr || error.message))) throw error; }
  if (!release) {
    const notesFile = path.join(directory, `release-notes-${tag}.md`);
    fs.writeFileSync(notesFile, notes);
    gh(['release', 'create', tag, '--repo', repository, '--verify-tag', '--title', tag, '--notes-file', notesFile, ...files]);
    log(`Created GitHub release ${tag} with ${assets.join(', ')}`);
    return 'created';
  }
  if (release.draft) throw new Error(`Release ${tag} exists as a draft; publish or remove it manually`);
  const published = JSON.parse(gh(['api', `repos/${repository}/releases/${release.id}/assets?per_page=100`]));
  const missing = [];
  for (const name of assets) {
    const asset = published.find(entry => entry.name === name);
    if (!asset) { missing.push(name); continue; }
    if (assetDigest({repository, tag, asset, gh}) !== expected[name])
      throw new Error(`Published asset ${name} differs from the verified candidate; resolve the conflict manually`);
  }
  if (!missing.length) { log(`GitHub release ${tag} already holds matching assets`); return 'unchanged'; }
  gh(['release', 'upload', tag, '--repo', repository, ...missing.map(name => path.join(directory, name))]);
  log(`Added ${missing.join(', ')} to the existing GitHub release ${tag}`);
  return 'completed';
}
function uploadReleaseAsset({repository, tag, file, gh = (args, options) => run('gh', args, options)}) {
  gh(['release', 'upload', tag, '--repo', repository, '--clobber', file]);
}
async function retry(attempt, {attempts = 6, delayMs = 10000, log = console.log, retryIf = () => true} = {}) {
  let failure;
  for (let index = 1; index <= attempts; index += 1) {
    try { return await attempt(); }
    catch (error) {
      failure = error;
      if (!retryIf(error)) throw error;
      if (index < attempts) { log(`Attempt ${index} failed (${error.message}); retrying`); await new Promise(resolve => setTimeout(resolve, delayMs)); }
    }
  }
  throw failure;
}
module.exports = {SEMVER, sha256, run, tagVersion, commitSha, requireAncestry, compareVersions, declaredVersion, readChecksums, releaseNotes, ensureRelease, uploadReleaseAsset, assetDigest, retry};
