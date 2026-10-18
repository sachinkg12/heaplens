'use strict';
// Publish the IntelliJ ZIP that test-intellij built and verified. Exact intellij-vMAJOR.MINOR.PATCH tags only.
// Order: GitHub release (idempotent) -> JetBrains Marketplace upload -> receipt on the release.
// Marketplace re-packages uploads, so a rerun recognizes a previous upload only through that receipt.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const common = require('./release-common.cjs');
const {hostNotes} = require('./release-publication-notes.cjs');
const {publishRecord} = require('./release-baselines.cjs');
const MARKETPLACE = 'https://plugins.jetbrains.com';
const XML_ID = 'com.heaplens.analyzer';
const PLUGIN_ID = 35004;
const TARGET = 'darwin-arm64';
const RECEIPT = 'marketplace-receipt.json';
function embeddedVersion(archive, version, commands) {
  // The ZIP must contain exactly the plugin jar for this version, whose descriptor declares the same version.
  const jar = `heaplens-intellij/lib/heaplens-intellij-${version}.jar`;
  const entries = commands.unzip(['-Z1', archive]).split(/\r?\n/).filter(Boolean);
  const jars = entries.filter(entry => /^heaplens-intellij\/lib\/heaplens-intellij-.*\.jar$/.test(entry));
  if (jars.length !== 1 || jars[0] !== jar) throw new Error(`Candidate must contain exactly ${jar}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-intellij-descriptor-'));
  try {
    const extracted = path.join(temporary, 'plugin.jar');
    fs.writeFileSync(extracted, commands.unzip(['-p', archive, jar], {encoding:'buffer'}));
    const descriptor = commands.unzip(['-p', extracted, 'META-INF/plugin.xml']);
    const declared = common.declaredVersion(descriptor, /<version>([^<\s]+)<\/version>/, 'plugin descriptor');
    if (declared !== version) throw new Error(`Descriptor version ${declared} does not match the tag`);
    if (!new RegExp('<id>' + XML_ID.replace(/\./g, '\\.') + '</id>').test(descriptor)) throw new Error('Unexpected plugin id');
  } finally { fs.rmSync(temporary, {recursive:true, force:true}); } // Only this extracted descriptor.
}
function candidate(directory, version, commands) {
  const name = `heaplens-intellij-${version}-${TARGET}.zip`;
  const sums = common.readChecksums(directory);
  const archives = Object.keys(sums).filter(entry => entry.endsWith('.zip'));
  if (archives.length !== 1 || archives[0] !== name) throw new Error(`Candidate must contain exactly ${name}`);
  embeddedVersion(path.join(directory, name), version, commands);
  return {name, sums, size: fs.statSync(path.join(directory, name)).size};
}
async function publishedUpdate({version, fetchImpl}) {
  const response = await fetchImpl(`${MARKETPLACE}/api/plugins/${PLUGIN_ID}/updates?size=100`, {headers:{accept:'application/json'}});
  if (!response.ok) throw new Error('Cannot list Marketplace updates: HTTP ' + response.status);
  const updates = await response.json();
  if (!Array.isArray(updates)) throw new Error('Unexpected Marketplace update listing');
  const matches = updates.filter(update => update && update.version === version);
  if (matches.length > 1) throw new Error('Marketplace lists version ' + version + ' more than once');
  return matches[0] || null;
}
async function upload({token, archive, fetchImpl}) {
  const body = new FormData();
  body.set('xmlId', XML_ID);
  body.set('file', new Blob([fs.readFileSync(archive)], {type:'application/zip'}), path.basename(archive));
  const response = await fetchImpl(`${MARKETPLACE}/api/updates/upload`, {method:'POST', headers:{authorization:'Bearer ' + token}, body});
  if (!response.ok) throw new Error('Marketplace upload failed: HTTP ' + response.status); // The body is not echoed.
  return response.json().catch(() => ({}));
}
function receiptFor({repository, tag, directory, gh}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-marketplace-receipt-'));
  try {
    gh(['release', 'download', tag, '--repo', repository, '--pattern', RECEIPT, '--dir', temporary]);
    return JSON.parse(fs.readFileSync(path.join(temporary, RECEIPT), 'utf8'));
  } catch { return null; }
  finally { fs.rmSync(temporary, {recursive:true, force:true}); } // Only this receipt download.
}
async function release(env, {fetchImpl = fetch, gh, git, commands = {}, log = console.log} = {}) {
  gh ||= (args, options) => common.run('gh', args, options);
  commands = {unzip: (args, options) => common.run('unzip', args, options), ...commands};
  const version = common.tagVersion(env.GITHUB_REF, 'intellij-v');
  const tag = 'intellij-v' + version;
  const sha = common.commitSha(env.GITHUB_SHA);
  const root = env.GITHUB_WORKSPACE || process.cwd();
  common.requireAncestry(sha, env.RELEASE_BASE || 'origin/main', root, git);
  const gradle = common.declaredVersion(fs.readFileSync(path.join(root, 'intellij-plugin/build.gradle.kts'), 'utf8'), /^version = "([^"\n]+)"$/m, 'Gradle plugin');
  if (gradle !== version) throw new Error(`Tag ${tag} does not match the Gradle plugin version ${gradle}`);
  const directory = env.ARTIFACT_DIR;
  const {name, sums, size} = candidate(directory, version, commands);
  const notes = common.releaseNotes({tag, sha, sums, lines:[
    hostNotes(root, 'intellij', version),
    'IntelliJ IDEA 2026.1–2026.2 on macOS Apple Silicon. IntelliJ versions are independent of VS Code and CLI versions.',
    'The same ZIP is uploaded to JetBrains Marketplace, which runs its own verification before listing it.']});
  common.ensureRelease({repository: env.GITHUB_REPOSITORY, tag, directory, assets:[name, 'SHA256SUMS'], sums, notes, gh, log});
  const existing = await publishedUpdate({version, fetchImpl});
  if (existing) {
    const receipt = receiptFor({repository: env.GITHUB_REPOSITORY, tag, directory, gh});
    const recognized = receipt && receipt.version === version && receipt.sha256 === sums[name] &&
      receipt.update_id !== undefined && receipt.update_id !== null && String(receipt.update_id) === String(existing.id);
    if (recognized) {
      publishRecord({host:'intellij', version, commit:sha, repository:env.GITHUB_REPOSITORY, directory, gh, updateId:existing.id});
      log(`Marketplace already holds ${name} from a previous run (update ${existing.id}); upload skipped`); return 'unchanged';
    }
    throw new Error(`Marketplace already lists ${version} without a matching upload receipt; resolve this manually before rerunning`);
  }
  if (!env.JETBRAINS_MARKETPLACE_TOKEN) throw new Error('JETBRAINS_MARKETPLACE_TOKEN is not configured');
  const response = await upload({token: env.JETBRAINS_MARKETPLACE_TOKEN, archive: path.join(directory, name), fetchImpl});
  const receipt = {version, file: name, sha256: sums[name], bytes: size, update_id: response && response.id !== undefined ? response.id : null,
    source_commit: sha, uploaded_at: new Date().toISOString()};
  const receiptFile = path.join(directory, RECEIPT);
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
  common.uploadReleaseAsset({repository: env.GITHUB_REPOSITORY, tag, file: receiptFile, gh});
  publishRecord({host:'intellij', version, commit:sha, repository:env.GITHUB_REPOSITORY, directory, gh, updateId:receipt.update_id});
  log(`Uploaded ${name} to JetBrains Marketplace (update ${receipt.update_id}); it is listed after Marketplace verification`);
  return 'uploaded';
}
if (require.main === module) {
  release(process.env).then(result => console.log('IntelliJ release: ' + result)).catch(error => {
    console.error('IntelliJ release stopped: ' + error.message);
    process.exitCode = 1;
  });
}
module.exports = {release, candidate, publishedUpdate, XML_ID, PLUGIN_ID, RECEIPT};
