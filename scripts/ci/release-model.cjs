'use strict';
// Declarative host metadata; preparation, validation and tagging share these contracts.
const fs = require('node:fs');
const path = require('node:path');
const common = require('./release-common.cjs');
const HOSTS = {
  vscode: {label:'VS Code extension', prefix:'v', workflow:'ci.yml', job:'publish', versionFile:'package.json', readVersion:source => json(source).version},
  intellij: {label:'IntelliJ plugin', prefix:'intellij-v', workflow:'ci.yml', job:'publish-intellij', versionFile:'intellij-plugin/build.gradle.kts',
    readVersion:source => common.declaredVersion(source, /^version = "([^"\n]+)"$/m, 'Gradle plugin')},
  cli: {label:'Standalone CLI', prefix:'cli-v', workflow:'cli-package.yml', job:'publish-cli', versionFile:'scripts/distribution/config.json', readVersion:source => json(source).version}
};
const PLAN = 'scripts/ci/release-plan.json';
const RECORD = 'release-record.json';
const json = source => JSON.parse(source);
function version(value) {
  common.compareVersions(value, value);
  return value;
}
function hostVersion(host, read) {
  const config = HOSTS[host];
  if (!config) throw new Error('Unknown release host: ' + host);
  return version(config.readVersion(read(config.versionFile)));
}
function versions(read) {
  return Object.fromEntries(Object.keys(HOSTS).map(host => [host,hostVersion(host,read)]));
}
const readAt = root => file => fs.readFileSync(path.join(root, file), 'utf8');
function consistency(read) {
  const values = versions(read);
  const lock = json(read('package-lock.json'));
  if (lock.version !== values.vscode || lock.packages?.['']?.version !== values.vscode)
    throw new Error('VS Code manifest and lockfile versions differ');
  const crate = common.declaredVersion(read('hprof-analyzer/Cargo.toml'), /^version = "([^"\n]+)"$/m, 'analyzer crate');
  if (crate !== values.cli) throw new Error('CLI config and analyzer crate versions differ');
  const packages = read('hprof-analyzer/Cargo.lock').split(/^\[\[package\]\]\s*$/m);
  const analyzer = packages.filter(block => /^name = "hprof-analyzer"$/m.test(block));
  if (analyzer.length !== 1 || common.declaredVersion(analyzer[0], /^version = "([^"\n]+)"$/m, 'locked analyzer') !== values.cli)
    throw new Error('Analyzer crate and Cargo lockfile versions differ');
  // Gradle patches the built descriptor. Do not introduce a second source version.
  const descriptor = read('intellij-plugin/src/main/resources/META-INF/plugin.xml');
  const explicit = /<version>([^<]+)<\/version>/.exec(descriptor);
  if (explicit && explicit[1] !== values.intellij) throw new Error('Explicit plugin descriptor version differs from Gradle');
  return values;
}
function patch(value) {
  const parts = version(value).split('.').map(Number);
  parts[2] += 1;
  return parts.join('.');
}
function parseOptions(argv, allowed) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!allowed.includes(name) || Object.hasOwn(options, name) || !argv[index + 1] || argv[index + 1].startsWith('--'))
      throw new Error('Invalid or duplicate option: ' + name);
    options[name] = argv[++index];
  }
  return options;
}
module.exports = {HOSTS, PLAN, RECORD, hostVersion, versions, consistency, readAt, version, patch, parseOptions};
