'use strict';
const fs = require('node:fs');
const path = require('node:path');
const common = require('./release-common.cjs');
const {TARGETS} = require('./vscode-candidate.cjs');
const {registries, publishRegistry, verificationOptions} = require('./vscode-registries.cjs');
const {runTool,publicationEnvironment} = require('./vscode-tools.cjs');
const {publishRecord} = require('./release-baselines.cjs');
const {hostNotes} = require('./release-publication-notes.cjs');
function candidates({directory, version, sha, manifest, unzip}) {
  const records = TARGETS.map(target => {
    const record = JSON.parse(fs.readFileSync(path.join(directory, `vsix-${target}.json`), 'utf8'));
    if (record.schema !== 1 || record.target !== target || record.version !== version || record.source_commit !== sha ||
      record.publisher !== manifest.publisher || record.extension !== manifest.name || !/^[A-Za-z0-9._-]+\.vsix$/.test(record.file)) throw new Error('VSIX candidate provenance mismatch: ' + target);
    const archive = path.join(directory, record.file);
    if (!fs.lstatSync(archive).isFile() || common.sha256(fs.readFileSync(archive)) !== record.sha256) throw new Error('VSIX checksum mismatch: ' + target);
    const packaged = JSON.parse(unzip(['-p', archive, 'extension/package.json']));
    if (packaged.version !== version || packaged.publisher !== manifest.publisher || packaged.name !== manifest.name) throw new Error('Embedded VSIX manifest mismatch');
    const xml = unzip(['-p', archive, 'extension.vsixmanifest']);
    const identity = /<Identity\b([^>]+)>/.exec(xml)?.[1];
    const attr = name => new RegExp('\\b' + name + '="([^"<>]+)"').exec(identity || '')?.[1];
    if (attr('TargetPlatform') !== target || attr('Version') !== version || attr('Publisher') !== manifest.publisher || attr('Id') !== manifest.name)
      throw new Error('Embedded VSIX platform identity mismatch');
    return {...record, archive};
  });
  if (new Set(records.map(record => record.file)).size !== TARGETS.length) throw new Error('Duplicate VSIX filenames');
  const archives = fs.readdirSync(directory).filter(file => file.endsWith('.vsix')).sort();
  if (JSON.stringify(archives) !== JSON.stringify(records.map(record => record.file).sort())) throw new Error('Unexpected VSIX archive set');
  return records;
}
async function release(env, {git, gh, fetchImpl = fetch, upload, unzip, registryList, log = console.log, verify} = {}) {
  verify ||= verificationOptions(env);
  const root = env.GITHUB_WORKSPACE || process.cwd();
  git ||= (args, options) => common.run('git', args, {cwd:root,...options});
  gh ||= (args, options) => common.run('gh', args, options);
  unzip ||= args => common.run('unzip', args);
  const version = common.tagVersion(env.GITHUB_REF, 'v'), sha = common.commitSha(env.GITHUB_SHA), tag = 'v' + version;
  common.requireAncestry(sha, env.RELEASE_BASE || 'origin/main', root, git);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('VS Code version does not match tag');
  const directory = env.ARTIFACT_DIR;
  const artifacts = candidates({directory, version, sha, manifest, unzip});
  const sums = Object.fromEntries(artifacts.map(candidate => [candidate.file,candidate.sha256]));
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), Object.entries(sums).map(([name,digest]) => `${digest}  ${name}\n`).join(''));
  const notes = common.releaseNotes({tag, sha, sums, lines:[hostNotes(root, 'vscode', version)]});
  common.ensureRelease({repository:env.GITHUB_REPOSITORY, tag, directory, assets:[...Object.keys(sums),'SHA256SUMS'], sums, notes, gh, log});
  upload ||= (registry, candidate) => {
    if (!env[registry.token]) throw new Error(registry.token + ' is not configured');
    runTool(registry.tool, ['publish', '--packagePath', candidate.archive], {
      env:publicationEnvironment({...process.env,[registry.token]:env[registry.token]},registry.token), stdio:['ignore','pipe','pipe']
    });
  };
  for (const registry of registryList || registries(fetchImpl)) await publishRegistry({registry, candidates:artifacts, upload, log, verify});
  publishRecord({host:'vscode', version, commit:sha, repository:env.GITHUB_REPOSITORY, directory, gh});
  return 'published';
}
if (require.main === module) release(process.env).then(result => console.log('VS Code release: ' + result)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {release, candidates};
