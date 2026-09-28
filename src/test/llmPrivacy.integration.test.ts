import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { once } from 'events';
import { createInterface } from 'readline';
import * as path from 'path';
import { AnalysisData, formatAnalysisContext } from '../analysisContext';

// Explicit, opt-in local corpus only. Nothing is sent to an AI provider.
const binary = process.env.HEAPLENS_PRIVACY_SERVER;
const dumps: string[] = JSON.parse(process.env.HEAPLENS_PRIVACY_DUMPS || '[]');

async function withAnalysis(dump: string, legacy: boolean, check: (data: AnalysisData, query: (query: string) => Promise<any>) => Promise<void>): Promise<void> {
    assert.ok(binary);
    const child = spawn(binary, legacy ? ['--legacy'] : [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const fail = (error: Error) => { for (const waiter of pending.values()) { waiter.reject(error); } pending.clear(); };
    child.on('error', fail);
    child.on('exit', () => fail(new Error('Test server exited before completion')));
    const timeout = setTimeout(() => fail(new Error('Test analysis timed out')), 60_000);
    lines.on('line', line => {
        try {
            const message = JSON.parse(line);
            const key = message.method === 'heap_analysis_complete' ? 'analysis' : String(message.id);
            const waiter = pending.get(key);
            if (!waiter) { return; }
            pending.delete(key);
            if (message.error) { waiter.reject(new Error('Test RPC failed')); }
            else { waiter.resolve(message.params || message.result); }
        } catch { fail(new Error('Malformed JSON from test server')); }
    });
    function wait(key: string): Promise<any> {
        return new Promise((resolve, reject) => pending.set(key, { resolve, reject }));
    }
    try {
        const complete = wait('analysis');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'analyze_heap', params: { path: dump } }) + '\n');
        const result = await complete;
        assert.equal(result.status, 'completed');
        const data: AnalysisData = {
            summary: result.summary, topObjects: result.top_objects || [], leakSuspects: result.leak_suspects || [],
            classHistogram: result.class_histogram || [], wasteAnalysis: result.waste_analysis
        };
        await check(data, async query => {
            const answer = wait('2');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'execute_query', params: { path: dump, query } }) + '\n');
            return answer;
        });
    } finally {
        clearTimeout(timeout); lines.close(); child.kill(); await exited;
    }
}

test('real HPROF contexts omit contents without changing local data on indexed and legacy backends', {
    skip: !binary || dumps.length === 0, timeout: 15 * 60_000
}, async () => {
    for (const dump of dumps) {
        let indexed: AnalysisData['summary'];
        for (const legacy of [false, true]) {
            const started = performance.now();
            await withAnalysis(dump, legacy, async (data, query) => {
                const original = JSON.stringify(data);
                const context = formatAnalysisContext(data);
                assert.equal(JSON.stringify(data), original, 'local data must not be redacted in place');
                const replacement: AnalysisData = JSON.parse(original);
                for (const group of replacement.wasteAnalysis?.duplicate_strings || []) {
                    group.preview = 'SYNTHETIC_PRIVATE_VALUE_NOT_FOR_AI';
                }
                assert.equal(formatAnalysisContext(replacement), context, 'prompt must be independent of raw previews');
                assert.ok(!context.includes('SYNTHETIC_PRIVATE_VALUE_NOT_FOR_AI'));
                assert.ok(data.summary);
                if (!legacy) { indexed = data.summary; }
                else {
                    assert.ok(indexed);
                    for (const key of ['total_heap_size', 'reachable_heap_size', 'total_instances', 'total_arrays', 'total_gc_roots'] as const) {
                        assert.equal(data.summary[key], indexed[key], key);
                    }
                }
                if (path.basename(dump) === 'layout-default.hprof') {
                    // Reuse the recorded user-supplied MAT oracle; not a fresh MAT run.
                    const oracle = [[14176760392, 16, 16], [14176760768, 24, 24], [14176762104, 40, 40],
                        [14176766104, 32, 32], [14176776512, 152, 152]];
                    const result = await query('SELECT object_id, shallow_size, retained_size FROM instances WHERE ' +
                        oracle.map(row => `object_id = ${row[0]}`).join(' OR ') + ' ORDER BY object_id');
                    assert.deepEqual(result.rows, oracle);
                }
                console.log(JSON.stringify({ fixture: path.basename(dump), backend: legacy ? 'legacy' : 'indexed',
                    elapsed_ms: Math.round(performance.now() - started), duplicate_groups: data.wasteAnalysis?.duplicate_strings.length || 0,
                    context_characters: context.length, status: 'passed' }));
            });
        }
    }
});
