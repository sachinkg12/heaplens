#!/usr/bin/env node
'use strict';
// Distribution adapter only. The Rust CLI and the IDEs keep their own contracts.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { constants } = require('node:os');

function commandIndex(args) {
  const values = new Set(['--format', '--backend', '--rows', '--output', '--diagnostics', '--telemetry']);
  for (let i = 0; i < args.length; i++) {
    if (['analyze', 'query', 'compare', 'open'].includes(args[i])) return i;
    if (values.has(args[i])) { i++; continue; }
    if (['--quiet'].includes(args[i]) || [...values].some(flag => args[i].startsWith(flag + '='))) continue;
    // Leave help, malformed options and unrecognized commands to Clap.
    return -1;
  }
  return -1;
}
function launchPlan(root, args, { platform = process.platform, arch = process.arch, node = process.execPath } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!manifest.os.includes(platform) || !manifest.cpu.includes(arch))
    throw Error('This HeapLens CLI package supports macOS Apple Silicon only.');
  const executable = path.join(root, 'runtime', 'bin', 'heaplens');
  if (!fs.statSync(executable).isFile()) throw Error('Missing packaged analysis executable.');
  const argv = [...args], index = commandIndex(args);
  if (index >= 0 && args[index] === 'open') {
    const defaults = {
      '--node': node,
      '--ui-host': path.join(root, 'runtime', 'browser-ui', 'server.cjs'),
      '--server': path.join(root, 'runtime', 'bin', 'hprof-server')
    };
    const supplied = flag => args.some(arg => arg === flag || arg.startsWith(flag + '='));
    const injected = Object.entries(defaults).flatMap(([flag, value]) => supplied(flag) ? [] : [flag, value]);
    argv.splice(index + 1, 0, ...injected);
  }
  return { executable, args: argv };
}
function main(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    process.stderr.write('HeapLens CLI requires Node.js 22 or newer.\n');
    process.exitCode = 2; return;
  }
  let plan;
  try { plan = launchPlan(path.resolve(__dirname, '..'), args); }
  catch (error) {
    process.stderr.write((error.message.startsWith('This HeapLens') ? error.message : 'HeapLens CLI package is incomplete. Reinstall the standalone package.') + '\n');
    process.exitCode = 3; return;
  }
  // An owned POSIX process group lets Ctrl+C/termination reach the browser host
  // and its analysis servers, not only the Rust parent waiting for that host.
  const grouped = process.platform !== 'win32';
  const child = spawn(plan.executable, plan.args, { stdio: 'inherit', shell: false, detached: grouped, windowsHide: true });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      try { grouped && child.pid ? process.kill(-child.pid, signal) : child.kill(signal); }
      catch { /* Child may already have exited. */ }
    };
    handlers.set(signal, handler); process.on(signal, handler);
  }
  child.once('error', () => {
    process.stderr.write('Cannot start the packaged HeapLens executable. Check the installation and platform.\n');
    process.exitCode = 3;
  });
  child.once('close', (code, signal) => {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (process.exitCode === undefined) process.exitCode = code ?? (128 + (constants.signals[signal] || 1));
  });
}
if (require.main === module) main();
module.exports = { commandIndex, launchPlan };
