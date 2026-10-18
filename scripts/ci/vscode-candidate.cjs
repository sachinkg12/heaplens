'use strict';
// Run in each build job before its immutable platform artifact is uploaded.
const fs = require('node:fs');
const path = require('node:path');
const common = require('./release-common.cjs');
const TARGETS = ['darwin-arm64','darwin-x64','linux-x64','win32-x64'];
function stamp({directory, target, sha, manifest}) {
  common.commitSha(sha);
  if (!TARGETS.includes(target)) throw new Error('Unsupported VSIX target');
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.vsix'));
  if (files.length !== 1 || !/^[A-Za-z0-9._-]+\.vsix$/.test(files[0])) throw new Error('Expected exactly one VSIX in the build directory');
  const name = files[0], digest = common.sha256(fs.readFileSync(path.join(directory, name)));
  const record = {schema:1, source_commit:sha, target, version:manifest.version, publisher:manifest.publisher, extension:manifest.name, file:name, sha256:digest};
  fs.writeFileSync(path.join(directory, `vsix-${target}.json`), JSON.stringify(record, null, 2) + '\n');
  return record;
}
if (require.main === module) {
  try { stamp({directory:process.cwd(), target:process.env.VSCE_TARGET, sha:process.env.GITHUB_SHA, manifest:require(path.join(process.cwd(),'package.json'))}); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {stamp, TARGETS};
