// Build-time native packaging. Never downloads or executes a supplied binary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function targetOf(b) {
  if (b.length < 64) throw new Error('Truncated native executable');
  if (b.readUInt32LE(0) === 0xfeedfacf && b.readUInt32LE(12) === 2) {
    if (b.readUInt32LE(4) === 0x0100000c) return 'darwin-arm64';
    if (b.readUInt32LE(4) === 0x01000007) return 'darwin-x64';
  }
  if (b.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      b[4] === 2 && b[5] === 1 && [2, 3].includes(b.readUInt16LE(16)) && b.readUInt16LE(18) === 62) return 'linux-x64';
  if (b.toString('ascii', 0, 2) === 'MZ') {
    const pe = b.readUInt32LE(60);
    if (pe >= 64 && pe + 26 <= b.length && b.readUInt32LE(pe) === 0x4550 &&
        b.readUInt16LE(pe + 4) === 0x8664 && (b.readUInt16LE(pe + 22) & 2) &&
        b.readUInt16LE(pe + 24) === 0x20b) return 'win32-x64';
  }
  throw new Error('Unsupported executable format or architecture');
}

function stage(source, output, target) {
  if (!['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'].includes(target)) throw new Error('Unsupported package target');
  if (!fs.lstatSync(source).isFile()) throw new Error('Server input must be a regular file, not a symbolic link');
  const bytes = fs.readFileSync(source);
  const actual = targetOf(bytes);
  if (actual !== target) throw new Error(`Server is ${actual}, not requested ${target}`);
  fs.mkdirSync(output, {recursive: true});
  const binary = path.join(output, target === 'win32-x64' ? 'hprof-server.exe' : 'hprof-server');
  fs.writeFileSync(binary, bytes, {mode: 0o755});
  fs.chmodSync(binary, 0o755);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(output, 'server.properties'), `target=${target}\nsha256=${sha256}\n`);
  console.log(`Bundled ${target} server: ${bytes.length} bytes, SHA-256 ${sha256}`);
}
if (require.main === module) {
  try { stage(...process.argv.slice(2)); }
  catch (error) { console.error(`Cannot package server: ${error.message}`); process.exitCode = 1; }
}
module.exports = {targetOf, stage};
