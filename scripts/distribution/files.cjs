'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function configuration(input) {
  if (!input || input.schema_version !== 1 || input.target !== 'darwin-arm64' ||
      typeof input.version !== 'string' || typeof input.npm_name !== 'string' || typeof input.repository !== 'string' ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(input.version) ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(input.npm_name) || input.npm_name.length > 214 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.repository))
    throw Error('Invalid standalone distribution configuration.');
  return input;
}
function readRegular(file) {
  if (!fs.lstatSync(file).isFile()) throw Error('Distribution inputs must be regular files: ' + path.basename(file));
  return fs.readFileSync(file);
}
function appleSilicon(file) {
  const bytes = readRegular(file);
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c)
    throw Error('Expected a native Apple Silicon Mach-O binary: ' + path.basename(file));
  return bytes;
}
function write(root, relative, data, mode = 0o644) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data, { flag: 'wx', mode });
}
function inventory(root, prefix = '') {
  const entries = [];
  for (const name of fs.readdirSync(path.join(root, prefix)).sort()) {
    const relative = path.posix.join(prefix, name), file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isDirectory()) entries.push(...inventory(root, relative));
    else if (stat.isFile()) entries.push({ path: relative, bytes: stat.size, sha256: digest(fs.readFileSync(file)) });
    else throw Error('Unexpected symlink or special file in standalone package.');
  }
  return entries;
}
module.exports = { configuration, readRegular, appleSilicon, write, inventory, digest };
