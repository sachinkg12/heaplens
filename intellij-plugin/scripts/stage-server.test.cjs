const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {targetOf, stage} = require('./stage-server.cjs');
function header(target) {
  const b = Buffer.alloc(128);
  if (target.startsWith('darwin')) {
    b.writeUInt32LE(0xfeedfacf); b.writeUInt32LE(target.endsWith('arm64') ? 0x0100000c : 0x01000007, 4); b.writeUInt32LE(2, 12);
  } else if (target === 'linux-x64') {
    b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); b.writeUInt16LE(3, 16); b.writeUInt16LE(62, 18);
  } else {
    b.write('MZ'); b.writeUInt32LE(64, 60); b.writeUInt32LE(0x4550, 64);
    b.writeUInt16LE(0x8664, 68); b.writeUInt16LE(2, 86); b.writeUInt16LE(0x20b, 88);
  }
  return b;
}
test('identifies all four planned native targets from bytes, not filenames', () => {
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) assert.equal(targetOf(header(target)), target);
});
test('rejects scripts, truncated binaries, unsupported CPU and malformed PE offsets', () => {
  for (const b of [Buffer.from('#!/bin/sh'), Buffer.alloc(128), Buffer.alloc(4)]) assert.throws(() => targetOf(b));
  const armLinux = header('linux-x64'); armLinux.writeUInt16LE(183, 18); assert.throws(() => targetOf(armLinux));
  const badPe = header('win32-x64'); badPe.writeUInt32LE(0xffffffff, 60); assert.throws(() => targetOf(badPe));
});
test('stages exact bytes and a deterministic checksum, including paths with spaces', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens package '));
  t.after(() => fs.rmSync(root, {recursive: true, force: true})); // Test-owned temporary directory only.
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
    const bytes = header(target), source = path.join(root, 'input'); fs.writeFileSync(source, bytes);
    const output = path.join(root, target); stage(source, output, target);
    assert.deepEqual(fs.readFileSync(path.join(output, target === 'win32-x64' ? 'hprof-server.exe' : 'hprof-server')), bytes);
    assert.equal(fs.readFileSync(path.join(output, 'server.properties'), 'utf8'),
      `target=${target}\nsha256=${crypto.createHash('sha256').update(bytes).digest('hex')}\n`);
    assert.throws(() => stage(source, output, 'linux-arm64'));
    assert.throws(() => stage(source, output, target === 'linux-x64' ? 'darwin-x64' : 'linux-x64'));
  }
});
