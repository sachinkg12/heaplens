'use strict';
const fs = require('node:fs');
const path = require('node:path');
const common = require('./release-common.cjs');
const model = require('./release-model.cjs');
const notes = require('./release-notes.cjs');
function validate({read, git, head, base, release = false}) {
  const values = model.consistency(read);
  let changed = false;
  if (base) {
    common.commitSha(base);
    const previous = model.versions(file => git(['show', `${base}:${file}`]));
    changed = Object.keys(model.HOSTS).some(host => previous[host] !== values[host]);
    for (const host of Object.keys(model.HOSTS))
      if (common.compareVersions(values[host], previous[host]) < 0) throw new Error('Version rollback: ' + host);
  }
  let plan;
  try { plan = JSON.parse(read(model.PLAN)); }
  catch (error) {
    if (release || changed || error.code !== 'ENOENT') throw new Error('A version change requires a valid prepared release plan: ' + error.message);
    return {versions:values, prepared:false};
  }
  if (plan.schema !== 1 || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(plan.repository || '') || !/^\d{4}-\d{2}-\d{2}$/.test(plan.date || ''))
    throw new Error('Invalid release plan');
  if (plan.repository !== JSON.parse(read('scripts/distribution/config.json')).repository) throw new Error('Release repository mismatch');
  common.commitSha(plan.source);
  for (const host of Object.keys(model.HOSTS)) {
    if (plan.versions[host] !== values[host]) throw new Error('Release plan version mismatch: ' + host);
    const baseline = plan.notes[host].baseline;
    common.commitSha(baseline.commit); model.version(baseline.version);
    if (typeof baseline.evidence !== 'string' || baseline.evidence.trim().length < 8) throw new Error('Baseline evidence is required: ' + host);
    // This comparison is against the preceding published source, not the newest tag (which may be this very release).
    if (common.compareVersions(values[host], baseline.version) <= 0) throw new Error('Release version must advance its baseline: ' + host);
    for (const entry of plan.notes[host].entries) {
      common.commitSha(entry.sha);
      if (typeof entry.title !== 'string' || !entry.title.trim() || /[\r\n\u0000-\u001f]/.test(entry.title) ||
        (entry.pr !== null && (!Number.isSafeInteger(entry.pr) || entry.pr < 1))) throw new Error('Invalid release-note entry');
    }
  }
  notes.requireReviewed(plan);
  const expectedChangelog = notes.changelog(plan).trim();
  if (!read('CHANGELOG.md').includes(expectedChangelog)) throw new Error('Changelog does not match the generated release plan');
  const descriptor = read('intellij-plugin/src/main/resources/META-INF/plugin.xml');
  const match = /<change-notes><!\[CDATA\[([\s\S]*?)\]\]><\/change-notes>/.exec(descriptor);
  if (!match || match[1].trim() !== notes.html(plan.notes.intellij, plan.repository)) throw new Error('Plugin change notes do not match the release plan');
  if (release || changed) {
    for (const host of Object.keys(model.HOSTS)) {
      const section = plan.notes[host];
      const generated = notes.section({host, baseline:section.baseline, changes:notes.history({baseline:section.baseline.commit, head:plan.source, git})});
      const identity = entry => JSON.stringify([entry.sha, entry.pr, entry.shared]);
      if (JSON.stringify(section.entries.map(identity)) !== JSON.stringify(generated.entries.map(identity)))
        throw new Error('Missing or invented release-note provenance: ' + host);
    }
    common.requireAncestry(plan.source, head, undefined, args => git(args));
    const after = git(['diff', '--no-renames', '--name-only', '-z', plan.source, head]).split('\0').filter(Boolean);
    const descriptorPath = 'intellij-plugin/src/main/resources/META-INF/plugin.xml';
    const runtime = after.filter(file => file !== descriptorPath);
    if (notes.classify(runtime).hosts.length) throw new Error('Product code changed after note generation; prepare the release again');
    const original = git(['show', `${plan.source}:${descriptorPath}`]);
    const strip = text => text.replace(/<change-notes>[\s\S]*?<\/change-notes>/, '');
    if (strip(original) !== strip(descriptor)) throw new Error('Plugin configuration changed after preparation');
  }
  return {versions:values, prepared:true, plan};
}
function validateTree(root, {base, release = false, head = 'HEAD'} = {}) {
  const git = args => common.run('git', args, {cwd:root});
  const sha = git(['rev-parse', '--verify', head + '^{commit}']).trim();
  return validate({read:model.readAt(root), git, head:sha, base, release});
}
function main(env = process.env) {
  const root = env.GITHUB_WORKSPACE || process.cwd();
  let base;
  if (env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    base = env.GITHUB_EVENT_NAME === 'pull_request' ? event.pull_request?.base?.sha : event.before;
    if (/^0+$/.test(base || '') || env.GITHUB_REF?.startsWith('refs/tags/')) base = undefined;
  }
  const result = validateTree(root, {base, release:env.GITHUB_REF?.startsWith('refs/tags/') || false});
  console.log('Release consistency passed:', JSON.stringify(result.versions));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = {validate, validateTree, main};
