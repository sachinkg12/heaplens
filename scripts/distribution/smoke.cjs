'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { inventory, digest } = require('./files.cjs');
function fixture(count = 9) {
  const header = Buffer.alloc(12); header.writeUInt32BE(8);
  const heap = Buffer.alloc(27 + count);
  heap[0] = 255; heap.writeBigUInt64BE(512n, 1); heap[9] = 0x23;
  heap.writeBigUInt64BE(512n, 10); heap.writeUInt32BE(count, 22); heap[26] = 8;
  const record = Buffer.alloc(9); record[0] = 0x1c; record.writeUInt32BE(heap.length, 5);
  const end = Buffer.alloc(9); end[0] = 0x2c;
  return Buffer.concat([Buffer.from('JAVA PROFILE 1.0.2\0'), header, record, heap, end]);
}
async function browserSmoke(executable, file, cwd, env) {
  const child = spawn(executable, ['open', file, '--no-browser', '--telemetry', 'off'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close'); let raw = '', errorBytes = 0;
  child.stdout.on('data', bytes => { raw += bytes; if (raw.length > 8192) child.kill('SIGTERM'); });
  child.stderr.on('data', bytes => { errorBytes += bytes.length; });
  try {
    const deadline = Date.now() + 20000;
    while (!/http:\/\/127\.0\.0\.1:\d+\/dump\/[a-f0-9-]+#token=[a-zA-Z0-9_-]+/.test(raw)) {
      if (Date.now() > deadline || child.exitCode !== null) throw Error('Packaged browser host did not start.');
      await delay(25);
    }
    const url = new URL(raw.match(/http:\/\/127\.0\.0\.1:\d+\/dump\/[a-f0-9-]+#token=[a-zA-Z0-9_-]+/)[0]);
    const view = crypto.randomUUID(), session = url.pathname.split('/').at(-1);
    const headers = { 'X-HeapLens-Token': url.hash.slice('#token='.length), 'X-HeapLens-View': view };
    const request = async (route, message) => fetch(url.origin + route, { signal: AbortSignal.timeout(5000),
      method: message ? 'POST' : 'GET', headers: { ...headers, ...(message ? { Origin: url.origin, 'Content-Type': 'application/json' } : {}) },
      body: message ? JSON.stringify({ session, message }) : undefined });
    const html = await fetch(url.origin + url.pathname); assert.equal(html.status, 200);
    const page = await html.text();
    for (const label of ['Overview', 'Histogram', 'Dominator Tree', 'Leak Suspects', 'Waste', 'Source', 'Query', 'Compare', 'Timeline', 'Monitor', 'AI Chat']) assert.ok(page.includes(label), label);
    assert.equal((await fetch(url.origin + '/api/catalog')).status, 403);
    assert.equal((await request('/api/command', { command: 'ready' })).status, 202);
    let cursor = 0, complete, query, pid;
    async function eventsUntil(predicate) {
      const end = Date.now() + 20000;
      while (!predicate()) {
        if (Date.now() > end) throw Error('Packaged engine did not complete the browser action.');
        const response = await request('/api/events?session=' + session + '&after=' + cursor);
        assert.equal(response.status, 200); const data = await response.json(); cursor = data.cursor;
        for (const event of data.events) {
          if (event.message.command === 'analysisComplete') complete = event.message;
          if (event.message.command === 'queryResult') query = event.message;
          if (event.message.command === 'browserStatus') pid = Number(event.message.message.match(/server PID (\d+)/)?.[1]) || pid;
          if (event.message.command === 'serverCrashed') throw Error('Packaged server crashed.');
        }
        await delay(25);
      }
    }
    await eventsUntil(() => complete); assert.equal(complete.summary.total_arrays, 1);
    await request('/api/command', { command: 'executeQuery', query: 'SELECT object_id FROM instances' });
    await eventsUntil(() => query); assert.equal(query.result.rows.length, 1);
    child.kill('SIGTERM');
    const [code, signal] = await Promise.race([closed, delay(10000).then(() => { throw Error('Packaged launcher did not stop.'); })]);
    assert.ok(code === 0 || code === 143 || signal === 'SIGTERM');
    assert.ok(pid, 'Packaged analysis server PID observed');
    await delay(100);
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'Owned analysis server must stop with launcher');
    await assert.rejects(fetch(url.origin + '/api/catalog', { signal: AbortSignal.timeout(1000) }));
    return { browser_views: 11, browser_analysis: 'passed', browser_query: 'passed', termination_cleanup: 'passed', stderr_bytes: errorBytes };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}
async function smoke(out) {
  const candidate = JSON.parse(fs.readFileSync(path.join(out, 'candidate.json'), 'utf8'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-installed-smoke-'));
  const env = { ...process.env, DO_NOT_TRACK: '1', CI: '1' };
  try {
    const prefix = path.join(temp, 'isolated npm prefix'), cache = path.join(temp, 'npm-cache');
    execFileSync('npm', ['install', '--global', '--prefix', prefix, '--cache', cache, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(out, candidate.npm_archive)], { cwd: temp, env, stdio: 'pipe', timeout: 60000 });
    const executable = path.join(prefix, 'bin/heaplens');
    const root = path.join(prefix, 'lib/node_modules', candidate.npm_name);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'distribution.json'), 'utf8'));
    for (const entry of manifest.files) assert.equal(digest(fs.readFileSync(path.join(root, entry.path))), entry.sha256, entry.path);
    assert.deepEqual(inventory(root).map(entry => entry.path).sort(), [...manifest.files.map(entry => entry.path), 'distribution.json'].sort());
    const run = args => execFileSync(executable, args, { cwd: temp, env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(run(['--version']).trim(), 'heaplens ' + candidate.version);
    assert.match(run(['--help']), /analyze/);
    const a = path.join(temp, 'synthetic dump with spaces.hprof'), b = path.join(temp, 'second.hprof');
    fs.writeFileSync(a, fixture()); fs.writeFileSync(b, fixture(19));
    const report = JSON.parse(run(['analyze', a, '--quiet', '--format', 'json']));
    assert.equal(report.status, 'completed'); assert.equal(report.data.summary.total_arrays, 1);
    assert.equal(JSON.parse(run(['query', a, 'SELECT object_id FROM instances', '--quiet', '--format', 'json'])).data.result.rows.length, 1);
    assert.equal(JSON.parse(run(['compare', a, b, '--quiet', '--format', 'json'])).status, 'completed');
    const exported = path.join(temp, 'new-report.json'); run(['analyze', a, '--quiet', '--format', 'json', '--output', exported]);
    assert.equal(JSON.parse(fs.readFileSync(exported, 'utf8')).status, 'completed');
    assert.throws(() => run(['analyze', a, '--quiet', '--output', exported]), error => error.status === 6);
    assert.throws(() => run(['analyze', path.join(temp, 'missing.hprof'), '--quiet']), error => error.status === 3);
    execFileSync('ruby', ['-c', path.join(out, 'homebrew/heaplens.rb')], { cwd: temp, env, stdio: 'pipe' });
    const result = { version: candidate.version, target: candidate.target, node: process.version, npm_local_install: 'passed', inventory: 'passed',
      help: 'passed', version_check: 'passed', analyze: 'passed', query: 'passed', compare: 'passed', export: 'passed',
      overwrite_rejection: 'passed', missing_dump: 'passed', homebrew_formula_syntax: 'passed', homebrew_real_install: 'not_tested',
      ...await browserSmoke(executable, a, temp, env), external_ai_requests: 'not_tested', telemetry_delivery: 'disabled_for_tests' };
    fs.writeFileSync(path.join(out, 'smoke-report.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return result;
  } finally {
    // Only the exact fresh directory owned by this smoke run.
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
if (require.main === module) smoke(path.resolve(process.argv[2] || '')).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error('Standalone installed smoke failed: ' + error.message); process.exitCode = 1; });
module.exports = { fixture, smoke };
