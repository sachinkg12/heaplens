import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { histogramHarness, Entry } from './histogramHarness';

// Opt-in read-only corpus. Use an explicitly chosen existing binary; no rebuild,
// downloads, provider requests or automatic scan of the user's heap files.
const binary = process.env.HEAPLENS_HISTOGRAM_SERVER;
const dumps: string[] = JSON.parse(process.env.HEAPLENS_HISTOGRAM_DUMPS || '[]');
assert.ok(binary && dumps.length > 0,
    'Set HEAPLENS_HISTOGRAM_SERVER and HEAPLENS_HISTOGRAM_DUMPS (JSON array) for this opt-in test');

async function withAnalysis(dump: string, legacy: boolean, check: (data: any, query: (sql: string) => Promise<any>) => Promise<void>) {
    assert.ok(binary);
    const child = spawn(binary, legacy ? ['--legacy'] : [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const lines = createInterface({ input: child.stdout });
    const pending = new Map<string, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
    const fail = (error: Error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
    child.on('error', fail);
    child.on('exit', () => fail(new Error('Test server exited before completion')));
    const timer = setTimeout(() => fail(new Error('Histogram matrix timed out')), 50_000);
    lines.on('line', line => {
        try {
            const message = JSON.parse(line);
            const key = message.method === 'heap_analysis_complete' ? 'analysis' : String(message.id);
            const waiter = pending.get(key);
            if (!waiter) return;
            pending.delete(key);
            if (message.error) waiter.reject(new Error('Test RPC failed'));
            else waiter.resolve(message.params || message.result);
        } catch { fail(new Error('Malformed server JSON')); }
    });
    const wait = (key: string) => new Promise<any>((resolve, reject) => pending.set(key, { resolve, reject }));
    function send(id: number, method: string, params: any) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }
    try {
        const complete = wait('analysis');
        send(1, 'analyze_heap', { path: dump });
        const data = await complete;
        assert.equal(data.status, 'completed'); assert.equal(data.request_id, 1);
        let id = 1;
        await check(data, sql => { const next = ++id, reply = wait(String(next));
            send(next, 'execute_query', { path: dump, query: sql, page: 1, page_size: 500 }); return reply; });
    } finally {
        clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); await closed;
    }
}

const indexedSummaries = new Map<string, any>();
for (const dump of dumps) for (const legacy of [false, true]) {
    test('Histogram table/CSV real heap: ' + path.basename(dump) + (legacy ? ' legacy' : ' indexed'), { timeout: 60_000 }, async () => {
        await withAnalysis(dump, legacy, async (data, query) => {
            const reachable = data.summary.reachable_heap_size;
            assert.ok(Number.isFinite(reachable) && reachable > 0);
            if (!legacy) indexedSummaries.set(dump, data.summary);
            else for (const key of ['total_heap_size', 'reachable_heap_size', 'total_instances', 'total_arrays', 'total_gc_roots'])
                assert.equal(data.summary[key], indexedSummaries.get(dump)[key], key);
            const entries: Entry[] = data.class_histogram;
            assert.ok(entries.length > 0);
            const h = histogramHarness();
            h.activate(); // Also exercise completion while Histogram is already visible.
            h.complete({ summary: data.summary, classHistogram: entries });
            if (entries.length > 200) h.showAll();
            const expected = entries.slice().sort((a, b) => b.retained_size - a.retained_size);
            const rows = h.rows(); assert.equal(rows.length, expected.length);
            for (let i = 0; i < rows.length; i++)
                assert.equal(rows[i][4], ((expected[i].retained_size / reachable) * 100).toFixed(1) + '%');
            assert.equal(h.csv(), 'Class Name,Instances,Shallow Size,Retained Size,% of Heap\n'
                + expected.map(e => '"' + e.class_name.replace(/"/g, '""') + '",' + e.instance_count + ','
                    + e.shallow_size + ',' + e.retained_size + ',' + ((e.retained_size / reachable) * 100).toFixed(1) + '\n').join(''));
            // Check the table's raw DTO against a separate engine query surface.
            const strings = entries.find(e => e.class_name === 'java.lang.String');
            assert.ok(strings);
            const queryResult = await query("SELECT instance_count, shallow_size, retained_size FROM class_histogram WHERE class_name = 'java.lang.String'");
            assert.deepEqual(queryResult.rows, [[strings.instance_count, strings.shallow_size, strings.retained_size]]);
            h.filter('java.lang.String');
            const stringRow = h.rows().find(row => row[0] === 'java.lang.String');
            assert.equal(stringRow?.[4], ((strings.retained_size / reachable) * 100).toFixed(1) + '%');
            console.log(JSON.stringify({ fixture: path.basename(dump), backend: legacy ? 'legacy' : 'indexed',
                reachable_heap: reachable, classes: entries.length, string_retained: strings.retained_size,
                old_string_percentage: ((strings.retained_size / entries.reduce((sum, e) => sum + e.retained_size, 0)) * 100).toFixed(1),
                corrected_string_percentage: stringRow?.[4], status: 'passed' }));
        });
    });
}
