import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { once } from 'events';
import { ChildProcess, execFileSync } from 'child_process';
import * as path from 'path';
import { RustClient } from '../rustClient';
import { editorHarness } from './editorHarness';

// Opt-in: use an existing binary and local dumps. No downloads, builds or VSIX creation.
const binary = process.env.HEAPLENS_RECOVERY_SERVER;
const dumps: string[] = JSON.parse(process.env.HEAPLENS_RECOVERY_DUMPS || '[]');

function canonical(value: any): any {
    if (Array.isArray(value)) {
        const items = value.map(canonical);
        return items.every(item => item && typeof item === 'object' && !Array.isArray(item))
            ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : items;
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}

function assertSameAnalysis(before: any, after: any): boolean {
    const oldGroups = before.wasteAnalysis?.duplicate_strings;
    const newGroups = after.wasteAnalysis?.duplicate_strings;
    let tiedCutoffChanged = false;
    if (oldGroups && newGroups && JSON.stringify(oldGroups) !== JSON.stringify(newGroups)) {
        // The existing waste query truncates a nondeterministically ordered tie at 50.
        // Permit different groups ONLY at that cutoff. Groups tied on wasted
        // bytes can have different copy counts/total bytes; headline totals
        // and every group above the cutoff must still match exactly.
        assert.equal(oldGroups.length, 50);
        assert.equal(newGroups.length, 50);
        const cutoff = Math.min(...oldGroups.map((group: any) => group.wasted_bytes));
        assert.deepEqual(newGroups.filter((group: any) => group.wasted_bytes > cutoff),
            oldGroups.filter((group: any) => group.wasted_bytes > cutoff));
        const amounts = (groups: any[]) => groups.map(group => group.wasted_bytes).sort((a, b) => a - b);
        assert.deepEqual(amounts(newGroups), amounts(oldGroups));
        after.wasteAnalysis.duplicate_strings = oldGroups;
        tiedCutoffChanged = true;
    }
    assert.deepEqual(after, before);
    return tiedCutoffChanged;
}

test('real HPROF process-kill/retry matrix preserves analysis and rebinds HeapQL', {
    skip: !binary || dumps.length === 0,
    timeout: 15 * 60_000
}, async () => {
    assert.ok(binary);
    for (const dump of dumps) {
        const clients: RustClient[] = [];
        const exits: Array<Promise<unknown>> = [];
        let sampledPeakRssKiB = 0;
        const host = editorHarness(() => {
            const client = new RustClient(binary);
            clients.push(client);
            const child = (client as unknown as { process: ChildProcess }).process;
            exits.push(once(child, 'exit'));
            return client;
        });
        const view = host.panel();
        const timer = setInterval(() => {
            const client = clients.at(-1);
            if (!client || client.isDisposed || process.platform !== 'darwin') { return; }
            const pid = (client as unknown as { process: ChildProcess }).process.pid;
            if (!pid) { return; }
            try {
                const rss = Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
                sampledPeakRssKiB = Math.max(sampledPeakRssKiB, rss);
            } catch { /* Sampling is optional and never changes the correctness outcome. */ }
        }, 100);
        try {
            const started = performance.now();
            await host.open(dump, view);
            await view.send({ command: 'ready' });
            const firstMs = performance.now() - started;
            const baseline = canonical(host.provider.getAnalysisData());
            assert.ok(baseline?.summary, `Analysis failed for ${dump}: ${host.errors.join('; ')}`);
            const query = 'SELECT object_id, class_name, shallow_size, retained_size FROM instances ORDER BY object_id LIMIT 10';
            await view.send({ command: 'executeQuery', query });
            const before = view.messages.at(-1);
            assert.equal(before.command, 'queryResult');
            assert.ok(Array.isArray(before.result.rows));
            assert.ok(before.result.rows.length > 0);
            const child = (clients[0] as unknown as { process: ChildProcess }).process;
            assert.equal(child.kill('SIGKILL'), true); // Only the child created by this test.
            await exits[0];
            assert.equal(view.messages.at(-1).command, 'serverCrashed');
            const restarting = performance.now();
            await view.send({ command: 'retryAnalysis' });
            const retryMs = performance.now() - restarting;
            assert.equal(clients.length, 2);
            assert.notEqual((clients[1] as unknown as { process: ChildProcess }).process.pid, child.pid);
            const tiedCutoffChanged = assertSameAnalysis(baseline, canonical(host.provider.getAnalysisData()));
            assert.equal(view.messages.at(-1).command, 'analysisComplete');
            await view.send({ command: 'executeQuery', query });
            const after = view.messages.at(-1);
            assert.equal(after.command, 'queryResult');
            assert.deepEqual(after.result.rows, before.result.rows);
            assert.deepEqual(after.result.columns, before.result.columns);
            if (path.basename(dump) === 'layout-default.hprof') {
                // Fixed addresses/sizes from the user's independent MAT comparison.
                const oracle = [[14176760392, 16, 16], [14176760768, 24, 24],
                    [14176762104, 40, 40], [14176766104, 32, 32], [14176776512, 152, 152]];
                await view.send({ command: 'executeQuery', query:
                    'SELECT object_id, shallow_size, retained_size FROM instances WHERE ' +
                    oracle.map(row => `object_id = ${row[0]}`).join(' OR ') + ' ORDER BY object_id'
                });
                assert.equal(view.messages.at(-1).command, 'queryResult');
                assert.deepEqual(view.messages.at(-1).result.rows, oracle);
            }
            console.log('RECOVERY_RESULT ' + JSON.stringify({
                file: path.basename(dump), first_ms: Math.round(firstMs), retry_ms: Math.round(retryMs),
                sampled_peak_rss_kib: sampledPeakRssKiB || null, summary: baseline.summary,
                existing_duplicate_string_cutoff_tie_changed: tiedCutoffChanged, status: 'passed'
            }));
        } finally {
            clearInterval(timer);
            host.provider.dispose();
            await Promise.all(exits);
        }
    }
});

const malformedDumps: string[] = JSON.parse(process.env.HEAPLENS_RECOVERY_BAD_DUMPS || '[]');

test('a real process killed during analysis recovers in the same editor', {
    skip: !binary || dumps.length === 0, timeout: 120_000
}, async () => {
    assert.ok(binary);
    const exits: Array<Promise<unknown>> = [];
    let clients = 0, killedDuringAnalysis = false;
    const host = editorHarness(() => {
        const client = new RustClient(binary);
        const child = (client as unknown as { process: ChildProcess }).process;
        exits.push(once(child, 'exit'));
        if (++clients === 1) {
            const register = client.onNotification.bind(client);
            client.onNotification = (method, handler) => register(method, params => {
                handler(params);
                if (method === 'heap_analysis_progress' && !killedDuringAnalysis) {
                    killedDuringAnalysis = child.kill('SIGKILL');
                }
            });
        }
        return client;
    });
    const view = host.panel();
    try {
        await host.open(dumps[0], view);
        await view.send({ command: 'ready' });
        assert.equal(killedDuringAnalysis, true);
        assert.equal(view.messages.at(-1).command, 'serverCrashed');
        await view.send({ command: 'retryAnalysis' });
        assert.equal(clients, 2);
        assert.equal(view.messages.at(-1).command, 'analysisComplete');
        assert.ok(host.provider.getAnalysisData()?.summary);
    } finally { host.provider.dispose(); await Promise.all(exits); }
});

test('real malformed dumps and their retries finish with a visible recoverable error', {
    skip: !binary || malformedDumps.length === 0, timeout: 120_000
}, async () => {
    assert.ok(binary);
    for (const dump of malformedDumps) {
        const exits: Array<Promise<unknown>> = [];
        const host = editorHarness(() => {
            const client = new RustClient(binary);
            exits.push(once((client as unknown as { process: ChildProcess }).process, 'exit'));
            return client;
        });
        const view = host.panel();
        try {
            await host.open(dump, view);
            await view.send({ command: 'ready' });
            assert.match(view.messages.at(-1)?.command, /^(analysisFailed|serverCrashed)$/);
            await view.send({ command: 'retryAnalysis' });
            assert.match(view.messages.at(-1)?.command, /^(analysisFailed|serverCrashed)$/);
            assert.equal(host.provider.getAnalysisData(), null);
            console.log('MALFORMED_RESULT ' + JSON.stringify({ file: path.basename(dump), status: 'passed' }));
        } finally { host.provider.dispose(); await Promise.all(exits); }
    }
});
