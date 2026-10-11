'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), http = require('node:http'), net = require('node:net');
const { BrowserHost, options } = require('./server.cjs'), { Sources, classParts } = require('./sources.cjs'), { parseExact, serialize } = require('./rpc.cjs'), AI = require('./ai.cjs'), { metrics } = require('./monitor.cjs');
const SERVER = process.env.HEAPLENS_TEST_SERVER || path.resolve(__dirname, '../hprof-analyzer/target/release/hprof-server');
const { spawn } = require('node:child_process');
function fixture(id = 512n, count = 9) {
    const header = Buffer.alloc(12);
    header.writeUInt32BE(8);
    const heap = Buffer.alloc(1 + 8 + 1 + 8 + 4 + 4 + 1 + count);
    let n = 0;
    heap[n++] = 255;
    heap.writeBigUInt64BE(id, n);
    n += 8;
    heap[n++] = 0x23;
    heap.writeBigUInt64BE(id, n);
    n += 8;
    n += 4;
    heap.writeUInt32BE(count, n);
    n += 4;
    heap[n] = 8;
    const record = Buffer.alloc(9);
    record[0] = 0x1c;
    record.writeUInt32BE(heap.length, 5);
    const end = Buffer.alloc(9);
    end[0] = 0x2c;
    return Buffer.concat([Buffer.from('JAVA PROFILE 1.0.2\0'), header, record, heap, end]);
}
async function until(condition, timeout = 8000) { const end = Date.now() + timeout; while (!condition()) {
    if (Date.now() > end)
        throw Error('Timed out waiting for test condition');
    await new Promise(resolve => setTimeout(resolve, 20));
} }
async function setup(t, { legacy = false, id = 512n, count = 9 } = {}) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heaplens-browser-')));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const files = [];
    for (const [name, c] of [['one.hprof', count], ['two.hprof', count + 10]]) {
        const file = path.join(dir, name);
        await fs.writeFile(file, fixture(id, c));
        files.push({ path: file, label: name, size: fixture(id, c).length, mtime: Date.now() + c });
    }
    const host = await new BrowserHost({ server: SERVER, legacy, files, roots: [dir], telemetry: 'off' }).listen();
    t.after(() => host.shutdown());
    const sessions = [...host.sessions.values()], view = crypto.randomUUID();
    const request = async (route, body, headers = {}) => fetch(host.origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-HeapLens-Token': host.token, 'X-HeapLens-View': view, ...(body === undefined ? {} : { Origin: host.origin, 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const command = async (session, message) => { const response = await request('/api/command', { session: session.id, message }); assert.equal(response.status, 202); };
    const ready = async (session) => { await command(session, { command: 'ready' }); await until(() => session.state === 'ready'); };
    return { host, sessions, dir, view, request, command, ready };
}
test('CLI host arguments are explicit, bounded and loopback only', () => { assert.throws(() => options(['--server', 'x', '--dump', 'x', '--port', '65536'])); assert.throws(() => options(['--server', 'x', '--dump', 'x', '--host', '0.0.0.0'])); assert.equal(options(['--server', 'x', '--dump', 'x', '--no-browser']).browser, false); });
test('wide IDs stay exact through JSON RPC and typed snapshot serialization', () => { const v = parseExact('{"object_id":18446744073709551615,"class_name":"18446744073709551615"}'); assert.equal(v.object_id, '18446744073709551615'); const raw = serialize(v, true); assert.match(raw, /"object_id":18446744073709551615/); assert.match(raw, /"class_name":"18446744073709551615"/); assert.throws(() => parseExact('{"x": 01}')); });
test('HTTP rejects absent capability, hostile Host/Origin, query tokens and arbitrary RPC', async (t) => {
    const { host, request, sessions } = await setup(t);
    assert.equal((await fetch(host.origin + '/api/catalog')).status, 403);
    const hostileHost = await new Promise(resolve => { http.get(host.origin + '/api/catalog', { headers: { Host: 'evil.example', 'X-HeapLens-Token': host.token } }, res => { res.resume(); resolve(res.statusCode); }); });
    assert.equal(hostileHost, 403);
    assert.equal((await request('/api/catalog', undefined, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/catalog?token=' + host.token)).status, 403);
    assert.equal((await request('/api/command', { session: sessions[0].id, message: { command: 'export_json', path: '/private/tmp/overwrite' } })).status, 400);
    const html = await request('/dump/' + sessions[0].id);
    assert.equal(html.status, 200);
    const text = await html.text();
    assert.ok(!text.includes(host.token));
    assert.ok(!text.includes('__BRIDGE__'));
    assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(html.headers.get('access-control-allow-origin'), null);
});
for (const legacy of [false, true])
    test('real engine analysis, query, inspect, paths, referrers, children, flame, compare and timeline (' + (legacy ? 'legacy' : 'indexed') + ')', async (t) => {
        const { sessions: [a, b], command, ready } = await setup(t, { legacy });
        await ready(a);
        await ready(b);
        assert.ok(a.raw.summary.reachable_heap_size > 0);
        for (const [commandName, reply] of [['inspectObject', 'inspectObjectResponse'], ['gcRootPath', 'gcRootPathResponse'], ['getReferrers', 'referrersResponse'], ['getDominatorSubtree', 'dominatorSubtreeResponse'], ['dominatorChildren', 'dominatorChildrenResult']]) {
            await command(a, { command: commandName, requestId: commandName, objectId: 512 });
            await until(() => a.events.some(e => e.message.command === reply));
            assert.equal(a.events.find(e => e.message.command === reply).message.error, undefined);
        }
        await command(a, { command: 'executeQuery', query: 'SELECT object_id, shallow_size FROM instances ORDER BY object_id' });
        await until(() => a.events.some(e => e.message.command === 'queryResult'));
        assert.ok(a.events.find(e => e.message.command === 'queryResult').message.result.rows.length);
        await command(a, { command: 'histogramInstances', requestId: 'hist', className: 'byte[]' });
        await until(() => a.events.some(e => e.message.command === 'histogramInstancesResult'));
        await command(b, { command: 'compareHeaps', requestId: 'compare', baselinePath: a.id });
        await until(() => b.events.some(e => e.message.command === 'compareResult'));
        assert.equal(b.events.find(e => e.message.command === 'compareResult').message.result.summary_delta.total_heap_size_delta, 8);
        await command(b, { command: 'getTimelineData', requestId: 'timeline', paths: [a.id, b.id] });
        await until(() => b.events.some(e => e.message.command === 'timelineDataResponse'));
        assert.equal(b.events.find(e => e.message.command === 'timelineDataResponse').message.result.snapshots.length, 2);
        await command(a, { command: 'inspectObject', requestId: 'unsafe', objectId: 9007199254740992 });
        await until(() => a.events.some(e => e.message.requestId === 'unsafe'));
        assert.match(a.events.find(e => e.message.requestId === 'unsafe').message.error, /unsupported/);
    });
test('comparison with full u64 object IDs is not rounded or rejected', async (t) => { const { sessions: [a, b], ready, command } = await setup(t, { id: 18446744073709551615n }); await ready(a); await ready(b); await command(b, { command: 'compareHeaps', requestId: 'wide', baselinePath: a.id }); await until(() => b.events.some(e => e.message.requestId === 'wide')); assert.equal(b.events.find(e => e.message.requestId === 'wide').message.command, 'compareResult'); });
test('server kill/Retry gets a fresh PID; closing one does not affect another', async (t) => {
    const { sessions: [a, b], ready, command, request } = await setup(t);
    await ready(a);
    await ready(b);
    const old = a.rpc.child.pid;
    process.kill(old, 'SIGKILL');
    await until(() => a.state === 'failed');
    await command(a, { command: 'retryAnalysis' });
    await until(() => a.state === 'ready');
    assert.notEqual(a.rpc.child.pid, old);
    assert.equal(b.state, 'ready');
    a.emit('browserSource', { text: 'SOURCE-PRIVATE-SENTINEL' });
    await command(a, { command: 'closeDump' });
    await until(() => a.state === 'closed');
    assert.ok(!JSON.stringify(a.events).includes('SOURCE-PRIVATE-SENTINEL'));
    assert.equal((await request('/dump/' + a.id)).status, 403);
    await command(b, { command: 'executeQuery', query: 'SELECT object_id FROM instances LIMIT 1' });
    await until(() => b.events.some(e => e.message.command === 'queryResult'));
});
test('queued Cancel/Retry works and stale reads cannot overwrite the recovered page', async (t) => {
    const { host, sessions: [a], command, ready } = await setup(t);
    let release;
    host.queue = new Promise(resolve => release = resolve);
    await command(a, { command: 'ready' });
    await until(() => a.state === 'queued');
    await command(a, { command: 'cancelAnalysis' });
    await until(() => a.state === 'cancelled');
    release();
    await command(a, { command: 'retryAnalysis' });
    await until(() => a.state === 'ready');
    const original = a.engine;
    let reject;
    a.engine = () => new Promise((_, r) => reject = r);
    const pending = a.dispatch({ command: 'executeQuery', query: 'SELECT * FROM instances LIMIT 1' });
    await until(() => reject);
    a.engine = original;
    await command(a, { command: 'retryAnalysis' });
    await until(() => a.state === 'ready');
    const seq = a.seq;
    reject(Error('retired'));
    await pending;
    assert.ok(!a.events.some(e => e.seq > seq && e.message.command === 'queryError'));
    await ready(a);
});
test('source confinement, inner/$ top-level classes, duplicate labels and symlink rejection', async (t) => {
    const { dir, host, sessions: [a], ready, command } = await setup(t);
    await fs.mkdir(path.join(dir, 'example'));
    await fs.writeFile(path.join(dir, 'example/Foo.java'), 'class Foo {}');
    await fs.writeFile(path.join(dir, '$Foo.java'), 'class $Foo {}');
    assert.deepEqual(classParts('$Foo'), ['$Foo.java']);
    assert.deepEqual(classParts('example.Foo$Nested'), ['example', 'Foo.java']);
    assert.throws(() => classParts('../secret'));
    await fs.symlink('/etc/passwd', path.join(dir, 'example/Secret.java'));
    const sources = new Sources([dir]);
    assert.equal((await sources.find('example.Secret')).length, 0);
    const [file] = await sources.find('example.Foo');
    assert.equal(file.rootIndex, 1);
    assert.equal(await sources.read(file), 'class Foo {}');
    await assert.rejects(() => sources.read({ ...file, file: '/etc/passwd' }));
    await ready(a);
    await command(a, { command: 'openProjectSource', requestId: 'src', className: 'example.Foo' });
    await until(() => a.events.some(e => e.message.command === 'browserSource'));
    assert.equal(a.events.find(e => e.message.command === 'browserSource').message.text, 'class Foo {}');
    host.sources.files = null;
});
test('fresh page attachment and AI Clear purge one-shot sensitive events, history and approval', async (t) => {
    const { sessions: [a], ready, command, request, host } = await setup(t);
    await ready(a);
    a.history = [{ role: 'user', content: 'HISTORY-SENTINEL' }];
    a.chatGrant = 'approved';
    a.emit('browserSource', { text: 'SOURCE-SENTINEL' });
    a.emit('browserConsent', { id: 'old', message: 'old' });
    a.attach(crypto.randomUUID());
    assert.equal(a.events.length, 0);
    assert.equal(a.chatGrant, null);
    const newView = a.view;
    const response = await request('/api/events?session=' + a.id + '&after=0', undefined, { 'X-HeapLens-View': newView });
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes('SOURCE-SENTINEL'));
    await a.dispatch({ command: 'aiClear' });
    assert.equal(a.history.length, 0);
    assert.ok(!JSON.stringify(a.events).includes('HISTORY-SENTINEL'));
    assert.equal((await request('/api/events?session=' + a.id + '&after=0')).status, 400);
    assert.ok(host.http.listening);
});
test('AI context drops raw values and local paths without pretending to anonymize class names', () => { const raw = { summary: { total_heap_size: 123 }, class_histogram: [{ class_name: 'SensitiveName', instance_count: 2, primitive_value: 'SECRET' }], waste_analysis: { total_wasted_bytes: 5, duplicate_strings: [{ preview: 'RAW-SECRET' }] }, path: '/private/source' }; const text = JSON.stringify(AI.context(raw)); assert.match(text, /SensitiveName/); assert.doesNotMatch(text, /SECRET|private/); assert.doesNotMatch(JSON.stringify(AI.objectMetadata([{ name: 'x', field_type: 'int', primitive_value: 'SECRET' }])), /SECRET/); });
test('AI endpoint validation fails closed for credentials, query/fragment, remote HTTP and prototype provider', async (t) => { const { host } = await setup(t); for (const baseUrl of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#secret', 'file:///tmp'])
    assert.throws(() => AI.configuration({ provider: 'openai', key: 'test', baseUrl }, host.providers)); assert.throws(() => AI.configuration({ provider: '__proto__', key: 'test' }, host.providers)); });
test('real local HTTP bodies for all ten providers honor Cancel, session consent, filtering and key masking', async (t) => {
    const { host, sessions: [a], ready, command } = await setup(t);
    const received = [];
    const mock = http.createServer(async (req, res) => { const chunks = []; for await (const x of req)
        chunks.push(x); received.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) }); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); const anthropic = req.url.endsWith('/messages'); res.end(anthropic ? 'data: {"type":"content_block_delta","delta":{"text":"heap answer"}}\n\ndata: {"type":"message_stop"}\n\n' : 'data: {"choices":[{"delta":{"content":"heap answer"}}]}\n\ndata: [DONE]\n\n'); });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => mock.close(resolve)));
    await ready(a);
    a.raw.waste_analysis.duplicate_strings = [{ preview: 'RAW-SENTINEL' }];
    const baseUrl = 'http://127.0.0.1:' + mock.address().port;
    for (const provider of Object.keys(host.providers)) {
        await command(a, { command: 'aiSetConfiguration', configuration: { provider, model: 'test-model', key: 'TEST-KEY-SENTINEL', baseUrl } });
        await command(a, { command: 'aiSend', requestId: 'cancel-' + provider, text: 'What retains memory?' });
        await until(() => a.pendingConsent);
        const before = received.length;
        await command(a, { command: 'browserConsentDecision', id: a.pendingConsent.id, decision: null });
        await until(() => !a.activeAi);
        assert.equal(received.length, before);
        await command(a, { command: 'aiSend', requestId: 'send-' + provider, text: 'What retains memory?' });
        await until(() => a.pendingConsent);
        assert.ok(!a.pendingConsent.message);
        await command(a, { command: 'browserConsentDecision', id: a.pendingConsent.id, decision: 'send' });
        await until(() => !a.activeAi);
        assert.equal(received.length, before + 1);
        assert.doesNotMatch(JSON.stringify(received.at(-1).body), /RAW-SENTINEL|TEST-KEY-SENTINEL/);
        assert.ok(received.at(-1).headers.authorization || received.at(-1).headers['x-api-key']);
        await command(a, { command: 'aiSend', requestId: 'again-' + provider, text: 'A second question' });
        await until(() => !a.activeAi);
        assert.equal(a.pendingConsent, null);
        assert.equal(received.length, before + 2);
        assert.ok(!JSON.stringify(a.events).includes('TEST-KEY-SENTINEL'));
    }
});
test('AI source Review/Cancel sends nothing; explicit approval includes full source but never its absolute path', async (t) => {
    const { dir, sessions: [a], ready, command } = await setup(t);
    await fs.writeFile(path.join(dir, 'Foo.java'), 'class Foo { String secret="APPROVED-SOURCE"; }');
    await ready(a);
    const bodies = [];
    const mock = http.createServer(async (req, res) => { const parts = []; for await (const p of req)
        parts.push(p); bodies.push(Buffer.concat(parts).toString()); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"class Foo {}"}}]}\n\ndata: [DONE]\n\n'); });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => mock.close(resolve)));
    await command(a, { command: 'aiSetConfiguration', configuration: { provider: 'openai', model: 'test', key: 'TEST-KEY', baseUrl: 'http://127.0.0.1:' + mock.address().port } });
    for (const decision of [null, 'review', 'send']) {
        await command(a, { command: 'fixWithAi', requestId: 'fix-' + String(decision), className: 'Foo' });
        await until(() => a.pendingConsent);
        await command(a, { command: 'browserConsentDecision', id: a.pendingConsent.id, decision });
        await until(() => !a.activeAi);
        if (decision !== 'send')
            assert.equal(bodies.length, 0);
    }
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /APPROVED-SOURCE/);
    assert.ok(!bodies[0].includes(dir));
    assert.equal(await fs.readFile(path.join(dir, 'Foo.java'), 'utf8'), 'class Foo { String secret="APPROVED-SOURCE"; }');
    assert.ok(a.events.some(e => e.message.command === 'browserDiff'));
});
test('monitor data is bounded, type checked and stripped of extra fields', () => { const raw = { timestamp: 1, heapUsed: 2, heapMax: 3, heapCommitted: 3, nonHeapUsed: 1, nonHeapCommitted: 1, threadCount: 1, daemonThreadCount: 0, uptime: 5, gcCollectors: [], memoryPools: [], secret: 'do not expose' }; assert.ok(!('secret' in metrics(raw))); assert.throws(() => metrics({ ...raw, heapUsed: NaN })); assert.throws(() => metrics({ ...raw, memoryPools: Array(101).fill({}) })); });
test('monitor Cancel makes zero TCP connections; approved local agent and histogram round trip work', async (t) => {
    const { sessions: [a], ready, command } = await setup(t);
    await ready(a);
    let connections = 0;
    const agent = net.createServer(socket => { connections++; socket.setEncoding('utf8'); socket.on('data', data => { for (const line of data.trim().split('\n')) {
        const req = JSON.parse(line);
        const frame = req.command === 'get_metrics' ? { type: 'metrics', data: { timestamp: 1, heapUsed: 2, heapMax: 3, heapCommitted: 3, nonHeapUsed: 1, nonHeapCommitted: 1, threadCount: 1, daemonThreadCount: 0, uptime: 5, gcCollectors: [], memoryPools: [] } } : { type: 'histogram', data: [{ className: 'byte[]', instanceCount: 1, totalBytes: 32 }] };
        socket.write(JSON.stringify(frame) + '\n');
    } }); });
    await new Promise(resolve => agent.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => agent.close(resolve)));
    for (const decision of [null, 'connect']) {
        await command(a, { command: 'startMonitor', host: '127.0.0.1', port: agent.address().port });
        await until(() => a.pendingConsent);
        await command(a, { command: 'browserConsentDecision', id: a.pendingConsent.id, decision });
        await until(() => decision === null || a.events.some(e => e.message.command === 'monitorMetrics'));
        if (decision === null)
            assert.equal(connections, 0);
    }
    assert.equal(connections, 1);
    await command(a, { command: 'requestMonitorHistogram' });
    await until(() => a.pendingConsent);
    await command(a, { command: 'browserConsentDecision', id: a.pendingConsent.id, decision: 'snapshot' });
    await until(() => a.events.some(e => e.message.command === 'monitorHistogram'));
    await command(a, { command: 'stopMonitor' });
});
module.exports = { fixture, setup, until };
test('approved root cannot be rebound to another directory before first source lookup', async (t) => { const { dir } = await setup(t); const root = path.join(dir, 'approved'), outside = path.join(dir, 'other'); await fs.mkdir(root); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'Foo.java'), 'outside'); const sources = new Sources([root]); await fs.rename(root, path.join(dir, 'retired-root')); await fs.symlink(outside, root); await assert.rejects(() => sources.find('Foo'), /moved/); });
test('browser CSV neutralizes quoted/unquoted formulas without losing negative numeric deltas', () => { const { safeCsv } = require('./export-actions.cjs'); const result = safeCsv('Class,Delta\n=CMD(),-12\n" \t@payload",3\n"a,b",0'); assert.match(result, /"'=CMD\(\)"/); assert.match(result, /"' \t@payload"/); assert.match(result, /"-12"/); assert.match(result, /"a,b"/); assert.throws(() => safeCsv('"unclosed')); });
test('mixed producer size models are retained and warned about in comparisons and timeline', async (t) => { const { sessions: [a, b], ready, command } = await setup(t); await ready(a); await ready(b); b.raw.summary.size_model = { ...(b.raw.summary.size_model || {}), fixture_model: 'different' }; await command(b, { command: 'compareHeaps', requestId: 'models', baselinePath: a.id }); await until(() => b.events.some(e => e.message.requestId === 'models')); assert.equal(b.events.find(e => e.message.requestId === 'models').message.sizeModelsDiffer, true); await command(b, { command: 'getTimelineData', requestId: 'model-times', paths: [a.id, b.id] }); await until(() => b.events.some(e => e.message.requestId === 'model-times')); const response = b.events.find(e => e.message.requestId === 'model-times').message; assert.equal(response.sizeModelsDiffer, true); assert.equal(response.result.snapshots[1].size_model.fixture_model, 'different'); });
test('real heaplens open launcher analyzes locally and Stop CLI releases its foreground service', async (t) => { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heaplens-open-process-'))), file = path.join(dir, 'launch.hprof'); await fs.writeFile(file, fixture()); t.after(() => fs.rm(dir, { recursive: true, force: true })); const cli = path.join(path.dirname(SERVER), process.platform === 'win32' ? 'heaplens.exe' : 'heaplens'); const child = spawn(cli, ['open', file, '--no-browser', '--server', SERVER, '--node', process.execPath, '--telemetry', 'off'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DO_NOT_TRACK: '1' } }); let stdout = '', launch = null, exit = null; child.stdout.on('data', chunk => { stdout += chunk; const line = stdout.split('\n').find(line => line.startsWith('http://127.0.0.1:')); if (line)
    launch = new URL(line); }); child.stderr.resume(); child.on('error', () => { exit = -1; }); child.on('exit', code => { exit = code; }); t.after(() => { if (exit === null)
    child.kill(); }); await until(() => launch || exit !== null); assert.ok(launch, 'foreground CLI should expose a private loopback launch URL'); const token = launch.hash.slice(7), origin = launch.origin, session = launch.pathname.split('/').at(-1), view = crypto.randomUUID(); const headers = { 'X-HeapLens-Token': token, 'X-HeapLens-View': view, Origin: origin, 'Content-Type': 'application/json' }; assert.equal((await fetch(origin + '/api/command', { method: 'POST', headers, body: JSON.stringify({ session, message: { command: 'ready' } }) })).status, 202); let ready = false; for (let n = 0; n < 100 && !ready; n++) {
    const result = await (await fetch(origin + '/api/events?session=' + session + '&after=0', { headers })).json();
    ready = result.events?.some(e => e.message.command === 'analysisComplete');
    if (!ready)
        await new Promise(resolve => setTimeout(resolve, 30));
} assert.equal(ready, true); await fetch(origin + '/api/command', { method: 'POST', headers, body: JSON.stringify({ session, message: { command: 'shutdown' } }) }); await until(() => exit !== null); assert.equal(exit, 0); await assert.rejects(() => fetch(origin + '/api/catalog', { headers })); });
