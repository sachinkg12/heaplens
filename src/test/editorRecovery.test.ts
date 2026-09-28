import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { editorHarness, FakeServer, settle } from './editorHarness';

test('Retry replaces a dead process and subsequent HeapQL uses the replacement', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => {
        const client = new FakeServer(); clients.push(client); return client;
    });
    const view = host.panel();
    try {
        await host.open('/tmp/recovery.hprof', view);
        await view.send({ command: 'ready' });
        clients[0].die();
        await view.send({ command: 'retryAnalysis' });
        assert.equal(clients.length, 2, 'Retry must create a fresh server without closing the editor');
        assert.equal(view.messages.filter(message => message.command === 'analysisComplete').length, 2);
        await view.send({ command: 'executeQuery', query: 'SELECT object_id FROM instances' });
        assert.equal(clients[1].requests.at(-1)?.method, 'execute_query');
        assert.equal(view.messages.at(-1)?.command, 'queryResult');
        await view.send({ command: 'inspectObject', objectId: 512 });
        assert.equal(clients[1].requests.at(-1)?.method, 'inspect_object');
        assert.ok(view.messages.at(-1)?.fields);
    } finally { host.provider.dispose(); }
});

test('rapid Retry clicks create one replacement and one analysis', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => {
        const client = new FakeServer(); client.autoComplete = clients.length === 0;
        clients.push(client); return client;
    });
    const view = host.panel();
    try {
        await host.open('/tmp/rapid.hprof', view);
        await view.send({ command: 'ready' });
        clients[0].die();
        const retries = Array.from({ length: 20 }, () => view.send({ command: 'retryAnalysis' }));
        await settle();
        assert.equal(clients.length, 2);
        assert.equal(clients[1].requests.filter(r => r.method === 'analyze_heap').length, 1);
        assert.equal(view.messages.filter(m => m.command === 'analysisRetrying').length, 1);
        clients[1].complete();
        await Promise.all(retries);
    } finally { host.provider.dispose(); }
});

test('late exit, progress and query error from the old process cannot overwrite recovery', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => { const c = new FakeServer(); clients.push(c); return c; });
    const view = host.panel();
    try {
        clients.length = 0;
        const opening = host.open('/tmp/stale.hprof', view);
        const oldProgress = clients[0].handlers.get('heap_analysis_progress');
        const oldExit = clients[0].onProcessExit;
        assert.ok(oldProgress); assert.ok(oldExit);
        await opening;
        await view.send({ command: 'ready' });
        let rejectQuery!: (error: Error) => void;
        clients[0].sendRequest = async () => new Promise((_resolve, reject) => { rejectQuery = reject; });
        const query = view.send({ command: 'executeQuery', query: 'SELECT * FROM instances' });
        clients[0].die();
        await view.send({ command: 'retryAnalysis' });
        const count = view.messages.length;
        oldExit(null, 'SIGTERM');
        oldProgress({ request_id: 1, phase: 1, total_phases: 4, stage: 'loading' });
        rejectQuery(new Error('old request failed'));
        await query;
        assert.equal(view.messages.length, count);
        assert.equal(host.provider.getEditorClient('/tmp/stale.hprof'), clients[1]);
    } finally { host.provider.dispose(); }
});

test('crash before ready replaces buffered success with a recoverable crash message', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => { const c = new FakeServer(); clients.push(c); return c; });
    const view = host.panel();
    try {
        await host.open('/tmp/buffer.hprof', view);
        clients[0].die();
        await view.send({ command: 'ready' });
        assert.equal(view.messages.filter(m => m.command === 'analysisComplete').length, 0);
        assert.equal(view.messages.at(-1).command, 'serverCrashed');
        await view.send({ command: 'retryAnalysis' });
        assert.equal(view.messages.at(-1).command, 'analysisComplete');
    } finally { host.provider.dispose(); }
});

test('unexpected clean exit is still unavailable and retryable', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => { const c = new FakeServer(); clients.push(c); return c; });
    const view = host.panel();
    try {
        await host.open('/tmp/clean-exit.hprof', view);
        await view.send({ command: 'ready' });
        clients[0].die(0, null);
        assert.equal(view.messages.at(-1).command, 'serverCrashed');
        await view.send({ command: 'retryAnalysis' });
        assert.equal(clients.length, 2);
    } finally { host.provider.dispose(); }
});

test('failed replacement leaves Retry available and a later attempt can succeed', async () => {
    let attempts = 0;
    const clients: FakeServer[] = [];
    const host = editorHarness(() => {
        if (++attempts === 2) { throw new Error('binary unavailable'); }
        const c = new FakeServer(); clients.push(c); return c;
    });
    const view = host.panel();
    try {
        await host.open('/tmp/spawn-fail.hprof', view);
        await view.send({ command: 'ready' });
        clients[0].die();
        await view.send({ command: 'retryAnalysis' });
        assert.equal(view.messages.at(-1).command, 'analysisFailed');
        assert.equal(host.provider.getAnalysisData(), null);
        await view.send({ command: 'retryAnalysis' });
        assert.equal(view.messages.at(-1).command, 'analysisComplete');
        assert.equal(attempts, 3);
    } finally { host.provider.dispose(); }
});

test('asynchronous spawn error terminates the job and permits Retry', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => {
        const c = new FakeServer(); c.autoComplete = clients.length > 0; clients.push(c); return c;
    });
    const view = host.panel();
    try {
        const opening = host.open('/tmp/async-spawn.hprof', view);
        await settle();
        clients[0].onProcessError?.(new Error('EACCES'));
        await opening;
        await view.send({ command: 'ready' });
        assert.equal(view.messages.at(-1).command, 'serverCrashed');
        await view.send({ command: 'retryAnalysis' });
        assert.equal(view.messages.at(-1).command, 'analysisComplete');
    } finally { host.provider.dispose(); }
});

test('closing during recovery disposes the replacement without late UI errors or respawn', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => {
        const c = new FakeServer(); c.autoComplete = clients.length === 0; clients.push(c); return c;
    });
    const view = host.panel();
    try {
        await host.open('/tmp/closed.hprof', view);
        await view.send({ command: 'ready' });
        clients[0].die();
        const retry = view.send({ command: 'retryAnalysis' });
        await settle();
        const lateExit = clients[1].onProcessExit;
        assert.ok(lateExit);
        view.close();
        const count = view.messages.length;
        lateExit(null, 'SIGTERM');
        await retry;
        await host.provider.retryAnalysis('/tmp/closed.hprof');
        assert.equal(clients[1].isDisposed, true);
        assert.equal(view.messages.length, count);
        assert.equal(clients.length, 2);
        assert.deepEqual(host.errors, []);
    } finally { host.provider.dispose(); }
});

test('Retry after cooperative cancellation reuses the live process', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => {
        const c = new FakeServer(); c.autoComplete = false; clients.push(c); return c;
    });
    const view = host.panel();
    try {
        const opening = host.open('/tmp/cancel.hprof', view);
        await settle();
        await view.send({ command: 'ready' });
        await view.send({ command: 'cancelAnalysis' });
        await opening;
        assert.equal(view.messages.at(-1).command, 'analysisCancelled');
        clients[0].autoComplete = true;
        await view.send({ command: 'retryAnalysis' });
        assert.equal(clients.length, 1);
        assert.equal(view.messages.at(-1).command, 'analysisComplete');
    } finally { host.provider.dispose(); }
});

test('a crash during an active job can recover without waiting for an analysis timeout', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => {
        const c = new FakeServer(); c.autoComplete = clients.length > 0; clients.push(c); return c;
    });
    const view = host.panel();
    try {
        const opening = host.open('/tmp/running.hprof', view);
        await settle();
        clients[0].die();
        await opening;
        await view.send({ command: 'ready' });
        await view.send({ command: 'retryAnalysis' });
        assert.equal(clients.length, 2);
        assert.equal(view.messages.at(-1).command, 'analysisComplete');
    } finally { host.provider.dispose(); }
});

test('recovering one editor does not disturb another editor', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => { const c = new FakeServer(); clients.push(c); return c; });
    const first = host.panel(), second = host.panel();
    try {
        await host.open('/tmp/first.hprof', first);
        await host.open('/tmp/second.hprof', second);
        await first.send({ command: 'ready' });
        await second.send({ command: 'ready' });
        const count = second.messages.length;
        clients[0].die();
        await first.send({ command: 'retryAnalysis' });
        assert.equal(second.messages.length, count);
        assert.equal(clients[1].isDisposed, false);
        await second.send({ command: 'executeQuery', query: 'SELECT * FROM instances' });
        assert.equal(clients[1].requests.at(-1)?.method, 'execute_query');
        assert.equal(clients[2].requests.at(-1)?.method, 'analyze_heap');
    } finally { host.provider.dispose(); }
});

test('malformed processing acknowledgement ends in a Retry-capable error state', async () => {
    const c = new FakeServer();
    c.sendRequest = async () => ({ status: 'processing', request_id: 'bad-id' });
    const host = editorHarness(() => c);
    const view = host.panel();
    try {
        await host.open('/tmp/bad-ack.hprof', view);
        await view.send({ command: 'ready' });
        assert.equal(view.messages.at(-1).command, 'analysisFailed');
    } finally { host.provider.dispose(); }
});

test('closing and reopening the same dump fences all callbacks from its former editor', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => { const c = new FakeServer(); clients.push(c); return c; });
    const oldView = host.panel(), newView = host.panel();
    try {
        await host.open('/tmp/reopened.hprof', oldView);
        const oldExit = clients[0].onProcessExit;
        assert.ok(oldExit);
        oldView.close();
        await host.open('/tmp/reopened.hprof', newView);
        await newView.send({ command: 'ready' });
        const count = newView.messages.length;
        oldExit(null, 'SIGTERM');
        await oldView.send({ command: 'retryAnalysis' });
        oldView.close();
        assert.equal(newView.messages.length, count);
        assert.equal(clients.length, 2);
        assert.equal(clients[1].isDisposed, false);
        assert.equal(host.provider.getEditorClient('/tmp/reopened.hprof'), clients[1]);
    } finally { host.provider.dispose(); }
});
