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
const platforms = require('../../intellij-plugin/scripts/platforms.cjs');
const MARKETPLACE = 'https://plugins.jetbrains.com';
const XML_ID = 'com.heaplens.analyzer';
const PLUGIN_ID = 35004;
const TARGET = 'darwin-arm64';
const RECEIPT = 'marketplace-receipt.json';
function embeddedVersion(archive, version, commands, target=TARGET) {
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
    if (declared !== platforms.variantVersion(version,target)) throw new Error(`Descriptor version ${declared} does not match the tag and platform`);
    if (!new RegExp('<id>' + XML_ID.replace(/\./g, '\\.') + '</id>').test(descriptor)) throw new Error('Unexpected plugin id');
    const selected=platforms.platform(target);
    if(!descriptor.includes(`com.intellij.modules.os.${selected.os}`)||!descriptor.includes(`com.intellij.modules.arch.${selected.arch}`))throw Error('Descriptor platform constraints do not match the package');
  } finally { fs.rmSync(temporary, {recursive:true, force:true}); } // Only this extracted descriptor.
}
function candidate(directory, version, commands, target=TARGET) {
  platforms.platform(target);
  const name = `heaplens-intellij-${version}-${target}.zip`;
  const sums = common.readChecksums(directory);
  const archives = Object.keys(sums).filter(entry => entry.endsWith('.zip'));
  const allowed=new Set(platforms.targets.map(value=>`heaplens-intellij-${version}-${value}.zip`));
  if (!archives.includes(name)||archives.some(value=>!allowed.has(value))) throw new Error(`Candidate must contain exactly the selected platform archive ${name} and no foreign ZIPs`);
  embeddedVersion(path.join(directory, name), version, commands, target);
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
function receiptName(target) {return target===TARGET?RECEIPT:`marketplace-receipt-${target}.json`;}
function receiptFor({repository, tag, directory, gh, target=TARGET}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-marketplace-receipt-'));
  try {
    gh(['release', 'download', tag, '--repo', repository, '--pattern', receiptName(target), '--dir', temporary]);
    return JSON.parse(fs.readFileSync(path.join(temporary, receiptName(target)), 'utf8'));
  } catch { return null; }
  finally { fs.rmSync(temporary, {recursive:true, force:true}); } // Only this receipt download.
}
async function release(env, {fetchImpl = fetch, gh, git, commands = {}, log = console.log, target=TARGET, recordPublication=true, releaseAssets} = {}) {
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
  const {name, sums, size} = candidate(directory, version, commands, target);
  const declaredVersion=platforms.variantVersion(version,target);
  const notes = common.releaseNotes({tag, sha, sums, lines:[
    hostNotes(root, 'intellij', version),
    'IntelliJ IDEA 2026.1–2026.3 on macOS Apple Silicon, macOS Intel, Linux x86-64 and Windows x86-64. IntelliJ versions are independent of VS Code and CLI versions.',
    'Each platform ZIP is uploaded unchanged. Marketplace selects its declared OS/CPU variant and verifies it before listing.']});
  common.ensureRelease({repository: env.GITHUB_REPOSITORY, tag, directory, assets:releaseAssets||[name, 'SHA256SUMS'], sums, notes, gh, log});
  const existing = await publishedUpdate({version:declaredVersion, fetchImpl});
  if (existing) {
    const receipt = receiptFor({repository: env.GITHUB_REPOSITORY, tag, directory, gh, target});
    const recognized = receipt && receipt.version === declaredVersion && receipt.sha256 === sums[name] &&
      receipt.update_id !== undefined && receipt.update_id !== null && String(receipt.update_id) === String(existing.id);
    if (recognized) {
      fs.writeFileSync(path.join(directory,receiptName(target)),JSON.stringify(receipt,null,2)+'\n');
      if(recordPublication)publishRecord({host:'intellij', version, commit:sha, repository:env.GITHUB_REPOSITORY, directory, gh, updateId:existing.id});
      log(`Marketplace already holds ${name} from a previous run (update ${existing.id}); upload skipped`); return 'unchanged';
    }
    throw new Error(`Marketplace already lists ${declaredVersion} without a matching upload receipt; resolve this manually before rerunning`);
  }
  if (!env.JETBRAINS_MARKETPLACE_TOKEN) throw new Error('JETBRAINS_MARKETPLACE_TOKEN is not configured');
  const response = await upload({token: env.JETBRAINS_MARKETPLACE_TOKEN, archive: path.join(directory, name), fetchImpl});
  if(!Number.isSafeInteger(response?.id)||response.id<1)throw new Error('Marketplace did not identify the accepted update; stop and reconcile the upload before retrying');
  const receipt = {version:declaredVersion, file: name, sha256: sums[name], bytes: size, update_id: response && response.id !== undefined ? response.id : null,
    source_commit: sha, uploaded_at: new Date().toISOString()};
  const receiptFile = path.join(directory, receiptName(target));
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
  common.uploadReleaseAsset({repository: env.GITHUB_REPOSITORY, tag, file: receiptFile, gh});
  if(recordPublication)publishRecord({host:'intellij', version, commit:sha, repository:env.GITHUB_REPOSITORY, directory, gh, updateId:receipt.update_id});
  log(`Uploaded ${name} to JetBrains Marketplace (update ${receipt.update_id}); it is listed after Marketplace verification`);
  return 'uploaded';
}
function collectCandidates(directory,version) {
  // download-artifact preserves one folder per native job, including its own
  // checksum file. Verify every folder before copying any archive for upload.
  const sets=platforms.targets.map(target=>{
    const source=path.join(directory,`intellij-${target}-candidate`);
    const sums=common.readChecksums(source);
    const name=`heaplens-intellij-${version}-${target}.zip`;
    if(Object.keys(sums).length!==1||!sums[name])throw Error('Incomplete native candidate: '+target);
    const metadata=JSON.parse(fs.readFileSync(path.join(source,'candidate.json'),'utf8'));
    if(metadata.target!==target||metadata.archive!==name||metadata.base_version!==version||metadata.descriptor_version!==platforms.variantVersion(version,target)||metadata.sha256!==sums[name]||metadata.native_tests!==true||metadata.os!==platforms.platform(target).hostOs||metadata.arch!==platforms.platform(target).hostArch)throw Error('Invalid native candidate metadata: '+target);
    return {source,name,digest:sums[name],metadata};
  });
  const output=fs.mkdtempSync(path.join(directory,'verified-'));
  for(const value of sets)fs.copyFileSync(path.join(value.source,value.name),path.join(output,value.name));
  fs.writeFileSync(path.join(output,'SHA256SUMS'),sets.map(x=>`${x.digest}  ${x.name}\n`).join(''));
  return {directory:output,sets};
}
async function releaseAll(env,options={}) {
  const version=common.tagVersion(env.GITHUB_REF,'intellij-v');
  const gathered=collectCandidates(env.ARTIFACT_DIR,version);
  const sha=common.commitSha(env.GITHUB_SHA);
  for(const value of gathered.sets)if(value.metadata.source_commit!==sha)throw Error('Native candidates do not belong to the tagged commit');
  const commands={unzip:(args,settings)=>common.run('unzip',args,settings),...options.commands};
  // Fail closed before any external write if even one platform is absent,
  // corrupt, mistargeted or carries a descriptor for another version.
  for(const target of platforms.targets)candidate(gathered.directory,version,commands,target);
  const releaseAssets=[...gathered.sets.map(x=>x.name),'SHA256SUMS'];
  const variants=[];
  for(const target of platforms.targets) {
    await release({...env,ARTIFACT_DIR:gathered.directory},{...options,commands,target,recordPublication:false,releaseAssets});
    const receipt=JSON.parse(fs.readFileSync(path.join(gathered.directory,receiptName(target)),'utf8'));
    variants.push({target,version:platforms.variantVersion(version,target),update_id:receipt.update_id});
  }
  const gh=options.gh||((args,settings)=>common.run('gh',args,settings));
  publishRecord({host:'intellij',version,commit:sha,repository:env.GITHUB_REPOSITORY,directory:gathered.directory,gh,updateId:variants.find(x=>x.target===TARGET).update_id,variants});
  return 'submitted-all-platforms';
}
if (require.main === module) {
  releaseAll(process.env).then(result => console.log('IntelliJ release: ' + result)).catch(error => {
    console.error('IntelliJ release stopped: ' + error.message);
    process.exitCode = 1;
  });
}
module.exports = {release, releaseAll, candidate, collectCandidates, publishedUpdate, receiptName, XML_ID, PLUGIN_ID, RECEIPT};
