'use strict';
const fs = require('node:fs');
const path = require('node:path');
const common = require('./release-common.cjs');
const model = require('./release-model.cjs');
const notes = require('./release-notes.cjs');
const baselines = require('./release-baselines.cjs');
function releaseDate(now = new Date()) {
  return [now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)
    throw new Error('Release date must be a real YYYY-MM-DD calendar date');
  return value;
}
function prepare({root, options = {}, git, gh, date, preview = false}) {
  git ||= args => common.run('git', args, {cwd:root});
  gh ||= args => common.run('gh', args, {cwd:root});
  if (git(['status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('Commit or preserve tracked changes before preparing a release');
  const source = common.commitSha(git(['rev-parse', 'HEAD']).trim());
  const read = model.readAt(root), current = model.consistency(read), versions = {};
  const repository = JSON.parse(read('scripts/distribution/config.json')).repository;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) throw new Error('Invalid repository');
  const plan = {schema:1, repository, source, date:validDate(options['--date'] || date || releaseDate()), versions, notes:{}};
  const remoteTags = git(['ls-remote','--tags','origin']).trim().split('\n').map(line => line.split(/\s+/)[1]).filter(Boolean);
  for (const host of Object.keys(model.HOSTS)) {
    versions[host] = model.version(options['--' + host] || model.patch(current[host]));
    if (common.compareVersions(versions[host], current[host]) <= 0) throw new Error('New version must exceed the current version: ' + host);
    for (const reference of remoteTags) {
      let existing;
      try { existing = common.tagVersion(reference, model.HOSTS[host].prefix); } catch { continue; }
      if (common.compareVersions(versions[host],existing) <= 0) throw new Error('New version must exceed remote tags: ' + host);
    }
    const explicit = options['--baseline-' + host];
    let baseline;
    if (explicit) {
      common.commitSha(explicit);
      const evidence = options['--baseline-' + host + '-evidence'];
      if (!evidence || evidence.trim().length < 8) throw new Error('Explain the verified manual baseline: ' + host);
      baseline = {version:model.hostVersion(host,file => git(['show', `${explicit}:${file}`])), commit:explicit, evidence};
    } else baseline = baselines.discover({host, repository, gh});
    if (common.compareVersions(versions[host], baseline.version) <= 0) throw new Error('Version does not advance the published baseline: ' + host);
    plan.notes[host] = notes.section({host, baseline, changes:notes.history({baseline:baseline.commit, head:source, git})});
  }
  const changes = new Map();
  const npm = JSON.parse(read('package.json')); npm.version = versions.vscode;
  const lock = JSON.parse(read('package-lock.json')); lock.version = versions.vscode; lock.packages[''].version = versions.vscode;
  changes.set('package.json', JSON.stringify(npm, null, 2) + '\n');
  changes.set('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
  changes.set('intellij-plugin/build.gradle.kts', read('intellij-plugin/build.gradle.kts').replace(/^version = "[^"\n]+"$/m, `version = "${versions.intellij}"`));
  const config = JSON.parse(read('scripts/distribution/config.json')); config.version = versions.cli;
  changes.set('scripts/distribution/config.json', JSON.stringify(config, null, 2) + '\n');
  changes.set('hprof-analyzer/Cargo.toml', read('hprof-analyzer/Cargo.toml').replace(/^version = "[^"\n]+"$/m, `version = "${versions.cli}"`));
  changes.set('hprof-analyzer/Cargo.lock', read('hprof-analyzer/Cargo.lock').split(/(?=^\[\[package\]\])/m).map(block =>
    /^name = "hprof-analyzer"$/m.test(block) ? block.replace(/^version = "[^"\n]+"$/m, `version = "${versions.cli}"`) : block).join(''));
  changes.set(model.PLAN, JSON.stringify(plan, null, 2) + '\n');
  const previous = read('CHANGELOG.md'), offset = previous.search(/^## /m);
  if (offset < 0) throw new Error('Cannot locate changelog insertion point');
  changes.set('CHANGELOG.md', previous.slice(0, offset) + notes.changelog(plan) + '\n' + previous.slice(offset));
  const descriptorPath = 'intellij-plugin/src/main/resources/META-INF/plugin.xml';
  const descriptor = read(descriptorPath);
  if (!/<change-notes>[\s\S]*?<\/change-notes>/.test(descriptor)) throw new Error('Cannot find plugin change notes');
  changes.set(descriptorPath, descriptor.replace(/<change-notes>[\s\S]*?<\/change-notes>/, `<change-notes><![CDATA[\n${notes.html(plan.notes.intellij, repository)}\n    ]]></change-notes>`));
  model.consistency(file => changes.get(file) ?? read(file));
  if (!preview) {
    const originals = new Map();
    // Preflight every target before any write; preserve unrelated/untracked user files.
    for (const file of changes.keys()) {
      const target = path.join(root, file);
      if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) throw new Error('Release target is not a regular file: ' + file);
      if (fs.existsSync(target)) {
        git(['ls-files', '--error-unmatch', '--', file]);
        originals.set(file, fs.readFileSync(target));
      } else originals.set(file, null);
    }
    try { for (const [file, content] of changes) fs.writeFileSync(path.join(root, file), content); }
    catch (error) {
      for (const [file, content] of originals) {
        const target = path.join(root, file);
        if (content === null) { if (fs.existsSync(target)) fs.unlinkSync(target); }
        else fs.writeFileSync(target, content);
      }
      throw error;
    }
  }
  return {plan, files:[...changes.keys()], changelog:notes.changelog(plan)};
}
function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--refresh-notes') {
    refreshNotes(process.cwd());
    console.log('Regenerated changelog and plugin HTML from the reviewed plan; versions unchanged.');
    return;
  }
  const preview = argv.includes('--preview');
  const allowed = ['--date',...Object.keys(model.HOSTS).flatMap(host => ['--' + host, '--baseline-' + host, '--baseline-' + host + '-evidence'])];
  const result = prepare({root:process.cwd(), preview, options:model.parseOptions(argv.filter(arg => arg !== '--preview'), allowed)});
  console.log(result.changelog);
  console.log(preview ? 'Preview only; no files changed.' : 'Prepared locally. Review the diff and release notes, then commit and open the release PR yourself. No branch, commit, tag, push or publication was created.');
}
function refreshNotes(root) {
  const read = model.readAt(root);
  const plan = JSON.parse(read(model.PLAN));
  const values = model.consistency(read);
  for (const host of Object.keys(model.HOSTS)) if (values[host] !== plan.versions[host]) throw new Error('Release plan version mismatch');
  const previous = read('CHANGELOG.md');
  const heading = `## [${values.vscode}] - ${plan.date}`;
  const offset = previous.indexOf(heading);
  if (offset < 0 || previous.indexOf(heading,offset+1) >= 0) throw new Error('Cannot uniquely locate the prepared changelog entry');
  const after = previous.slice(offset + heading.length).search(/^## /m);
  const end = after < 0 ? previous.length : offset + heading.length + after;
  const descriptorPath = 'intellij-plugin/src/main/resources/META-INF/plugin.xml';
  const descriptor = read(descriptorPath);
  if (!/<change-notes>[\s\S]*?<\/change-notes>/.test(descriptor)) throw new Error('Cannot locate plugin change notes');
  fs.writeFileSync(path.join(root,'CHANGELOG.md'),previous.slice(0,offset)+notes.changelog(plan)+'\n'+previous.slice(end));
  fs.writeFileSync(path.join(root,descriptorPath),descriptor.replace(/<change-notes>[\s\S]*?<\/change-notes>/,
    `<change-notes><![CDATA[\n${notes.html(plan.notes.intellij,plan.repository)}\n    ]]></change-notes>`));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = {prepare, refreshNotes, releaseDate, validDate, main};
