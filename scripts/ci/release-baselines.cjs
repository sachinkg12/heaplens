'use strict';
// A tag or version bump is release intent, not proof of a completed publication.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const common = require('./release-common.cjs');
const {HOSTS, RECORD, version} = require('./release-model.cjs');
function record(value, host) {
  if (value.schema !== 1 || value.host !== host || value.status !== (host === 'intellij' ? 'submitted' : 'published')) throw new Error('Invalid publication record');
  common.commitSha(value.commit);
  version(value.version);
  if (value.tag !== HOSTS[host].prefix + value.version) throw new Error('Publication record tag mismatch');
  return {version:value.version, commit:value.commit, evidence:value.tag + '/' + RECORD};
}
function discover({host, repository, gh, publicUpdates = () => JSON.parse(common.run('curl', [
  '--fail','--silent','--show-error','--max-time','30','https://plugins.jetbrains.com/api/plugins/35004/updates?size=100'
]))}) {
  const releases = JSON.parse(gh(['release', 'list', '--repo', repository, '--limit', '1000', '--json', 'tagName,isDraft,isPrerelease']));
  const candidates = releases.filter(release => !release.isDraft && !release.isPrerelease &&
    new RegExp('^' + HOSTS[host].prefix + '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$').test(release.tagName));
  candidates.sort((a,b) => common.compareVersions(b.tagName.slice(HOSTS[host].prefix.length), a.tagName.slice(HOSTS[host].prefix.length)));
  for (const candidate of candidates) {
    const assets = JSON.parse(gh(['api', `repos/${repository}/releases/tags/${candidate.tagName}`]));
    if (!assets.assets?.some(asset => asset.name === RECORD)) continue;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-baseline-'));
    try {
      gh(['release', 'download', candidate.tagName, '--repo', repository, '--pattern', RECORD, '--dir', directory]);
      const value = JSON.parse(fs.readFileSync(path.join(directory, RECORD), 'utf8'));
      const baseline = record(value, host);
      if (baseline.evidence !== candidate.tagName + '/' + RECORD) throw new Error('Release record belongs to another tag');
      if (host === 'intellij') {
        const updates = publicUpdates();
        if (!Array.isArray(updates)) throw new Error('Cannot verify public Marketplace approval');
        if (!updates.some(update => update.version === value.version && update.id === value.update_id && update.approve === true &&
          update.listed === true && update.hidden === false && !update.channel)) continue;
      }
      return baseline;
    } finally { fs.rmSync(directory, {recursive:true, force:true}); }
  }
  throw new Error(`No completed publication record for ${host}. Supply --baseline-${host} SHA and --baseline-${host}-evidence TEXT once, after verifying the manually published source. A version-bump commit is not assumed to be that source.`);
}
function publishRecord({host, version:releaseVersion, commit, repository, directory, gh, updateId}) {
  const tag = HOSTS[host].prefix + releaseVersion;
  const value = {schema:1, host, version:releaseVersion, commit, tag, status:host === 'intellij' ? 'submitted' : 'published'};
  if (host === 'intellij') {
    if (!Number.isSafeInteger(updateId) || updateId < 1) throw new Error('Marketplace did not identify the accepted update');
    value.update_id = updateId;
  }
  record(value, host);
  const file = path.join(directory, RECORD);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  // Stable bytes make retries safe; conflicting records must never be overwritten.
  const existing = JSON.parse(gh(['api', `repos/${repository}/releases/tags/${tag}`]));
  const asset = existing.assets?.find(entry => entry.name === RECORD);
  if (asset) {
    const actual = common.assetDigest({repository, tag, asset, gh});
    if (actual !== common.sha256(fs.readFileSync(file))) throw new Error('Conflicting publication record');
    return;
  }
  gh(['release', 'upload', tag, '--repo', repository, file]);
}
module.exports = {record, discover, publishRecord};
