import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { analysisStorageArguments, analysisStorageOptions, analysisStorageReport } from '../analysisStorage';
import type { readAnalysisStorage, registerAnalysisStorage } from '../vscodeAnalysisStorage';

test('storage defaults and arguments are fixed, bounded and shell-free', () => {
    assert.deepEqual(analysisStorageOptions(undefined, undefined), { mode: 'memory', edgeBufferMiB: 64 });
    assert.deepEqual(analysisStorageArguments({ mode: 'disk', edgeBufferMiB: 1 }), ['--storage', 'disk', '--edge-buffer-mib', '1']);
    for (const value of [0, -1, 1025, 2.5, NaN, '64', {}, '--cache-dir private']) {
        assert.equal(analysisStorageOptions('disk', value).edgeBufferMiB, 64);
    }
    assert.equal(analysisStorageOptions('--storage malicious', 64).mode, 'memory');
});

test('storage report projects only known labels, never paths or fingerprints', () => {
    assert.deepEqual(analysisStorageReport({ mode: 'disk', cache_status: 'reused', path: 'PRIVATE', sha256: 'PRIVATE' }), { mode: 'disk', cache_status: 'reused' });
    for (const value of [null, {}, { mode: 'PRIVATE', cache_status: 'built' }, { mode: 'memory', cache_status: 'built' }, { mode: 'disk', cache_status: 'PRIVATE' }]) {
        assert.equal(analysisStorageReport(value), undefined);
    }
});

function settingsHost(values: Record<string, unknown>, choose: 'memory' | 'disk' | undefined) {
    const updates: unknown[][] = [], notices: string[] = [];
    let action: () => Promise<void> = async () => undefined;
    const configuration = {
        inspect: (key: string) => values[key],
        update: async (...args: unknown[]) => { updates.push(args); }
    };
    const vscode = {
        ConfigurationTarget: { Global: 1 },
        workspace: { getConfiguration: () => configuration },
        commands: { registerCommand: (name: string, fn: typeof action) => { assert.equal(name, 'heaplens.configureAnalysisStorage'); action = fn; return { dispose: () => undefined }; } },
        window: {
            showQuickPick: async (choices: Array<{ mode: string }>) => choices.find(choice => choice.mode === choose),
            showInformationMessage: (message: string) => { notices.push(message); },
            showErrorMessage: (message: string) => { notices.push(message); }
        }
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const modules = require('module') as any, load = modules._load;
    const file = require.resolve('../vscodeAnalysisStorage'); delete require.cache[file];
    modules._load = function(request: string, parent: any, main: boolean) { return request === 'vscode' ? vscode : load.call(this, request, parent, main); };
    let adapter: { readAnalysisStorage: typeof readAnalysisStorage; registerAnalysisStorage: typeof registerAnalysisStorage };
    try { adapter = load(file, module, false); } finally { modules._load = load; }
    adapter.registerAnalysisStorage({ subscriptions: [] } as any);
    return { read: adapter.readAnalysisStorage, run: () => action(), updates, notices };
}

test('workspace settings cannot override the user storage policy', () => {
    const host = settingsHost({
        'analysis.storage': { defaultValue: 'memory', workspaceValue: 'disk', workspaceFolderValue: 'disk' },
        'analysis.edgeBufferMiB': { defaultValue: 64, workspaceValue: 1024 }
    }, undefined);
    assert.deepEqual(host.read(), { mode: 'memory', edgeBufferMiB: 64 });
});

test('normal selector persists the user choice without restarting active analyses', async () => {
    const host = settingsHost({ 'analysis.storage': { defaultValue: 'memory' } }, 'disk');
    await host.run();
    assert.deepEqual(host.updates, [['analysis.storage', 'disk', 1]]);
    assert.match(host.notices.join(' '), /Close and reopen/);
    assert.match(host.notices.join(' '), /automatically/);
});

test('dismissal and unchanged choices do not change settings', async () => {
    for (const choice of [undefined, 'memory'] as const) {
        const host = settingsHost({ 'analysis.storage': { defaultValue: 'memory' } }, choice);
        await host.run(); assert.equal(host.updates.length, 0); assert.equal(host.notices.length, 0);
    }
});
