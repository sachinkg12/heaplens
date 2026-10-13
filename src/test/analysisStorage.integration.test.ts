import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { once } from 'events';
import { ChildProcess } from 'child_process';
import { RustClient } from '../rustClient';
import { editorHarness } from './editorHarness';

// Explicit binary only: do not install an IDE, download a server or read a user dump.
const binary = process.env.HEAPLENS_TEST_SERVER;
function fixture(): Buffer {
    const header = Buffer.alloc(12); header.writeUInt32BE(8);
    const heap = Buffer.alloc(36); heap[0] = 255; heap.writeBigUInt64BE(512n, 1);
    heap[9] = 35; heap.writeBigUInt64BE(512n, 10); heap.writeUInt32BE(9, 22); heap[26] = 8;
    const record = Buffer.alloc(9); record[0] = 28; record.writeUInt32BE(heap.length, 5);
    const end = Buffer.alloc(9); end[0] = 44;
    return Buffer.concat([Buffer.from('JAVA PROFILE 1.0.2\0'), header, record, heap, end]);
}

test('real VS Code adapter selects disk, reports reuse, and restores queries/Waste after crash', { skip: !binary, timeout: 30_000 }, async () => {
    assert.ok(binary);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-vscode-storage-'));
    const dump = path.join(directory, 'fixture.hprof'), cache = path.join(directory, 'cache');
    fs.writeFileSync(dump, fixture());
    const clients: RustClient[] = [], exits: Array<Promise<unknown>> = [];
    const host = editorHarness(args => {
        assert.deepEqual(args, ['--storage', 'disk', '--edge-buffer-mib', '64']);
        const client = new RustClient(binary, [...(args || []), '--cache-dir', cache]);
        const child = (client as unknown as { process: ChildProcess }).process;
        clients.push(client); exits.push(once(child, 'exit')); return client;
    }, 'full', 'disk');
    try {
        let view = host.panel(); await host.open(dump, view); await view.send({ command: 'ready' });
        assert.deepEqual(view.messages.at(-1)?.storage, { mode: 'disk', cache_status: 'built' });
        assert.equal(host.provider.getAnalysisData()?.wasteAnalysis, undefined);
        const query = 'SELECT object_id, shallow_size, retained_size FROM instances ORDER BY object_id';
        await view.send({ command: 'executeQuery', query }); const expected = view.messages.at(-1).result.rows;
        assert.equal(expected.length, 1);
        view.close(); await exits[0];
        view = host.panel(); await host.open(dump, view); await view.send({ command: 'ready' });
        assert.deepEqual(view.messages.at(-1)?.storage, { mode: 'disk', cache_status: 'reused' });
        const oldPid = clients[1].processId;
        const child = (clients[1] as unknown as { process: ChildProcess }).process;
        child.kill('SIGKILL'); await exits[1]; await new Promise(resolve => setImmediate(resolve));
        await view.send({ command: 'retryAnalysis' });
        assert.notEqual(clients[2].processId, oldPid);
        assert.deepEqual(view.messages.at(-1)?.storage, { mode: 'disk', cache_status: 'reused' });
        await view.send({ command: 'executeQuery', query }); assert.deepEqual(view.messages.at(-1).result.rows, expected);
        await view.send({ command: 'calculateWaste', requestId: 'storage-waste' });
        assert.equal(view.messages.at(-1).command, 'wasteResult');
        assert.equal(host.provider.getAnalysisData()?.wasteAnalysis?.total_wasted_bytes, 0);
    } finally {
        host.provider.dispose(); await Promise.all(exits);
        fs.rmSync(directory, { recursive: true, force: true }); // Exact generated directory owned by this test.
    }
});
