import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    AnalysisRpcClient,
    AnalysisSession,
    AnalysisSessionCallbacks,
    AnalysisTimer
} from '../analysisSession';
import {
    deliverOrBufferWebviewMessage,
    markWebviewReadyAndFlush
} from '../webviewMessageDelivery';

class FakeClient implements AnalysisRpcClient {
    public readonly requests: Array<{ method: string; params: any; timeoutMs?: number }> = [];
    private readonly handlers = new Map<string, (params: any) => void>();

    public async sendRequest(method: string, params?: any, timeoutMs?: number): Promise<any> {
        this.requests.push({ method, params, timeoutMs });
        if (method === 'analyze_heap') {
            return { status: 'processing', request_id: 42 };
        }
        if (method === 'cancel_analysis') {
            return { cancelled: true };
        }
        throw new Error(`Unexpected request: ${method}`);
    }

    public onNotification(method: string, handler: (params: any) => void): void {
        this.handlers.set(method, handler);
    }

    public offNotification(method: string): void {
        this.handlers.delete(method);
    }

    public emit(method: string, params: any): void {
        this.handlers.get(method)?.(params);
    }

    public hasHandler(method: string): boolean {
        return this.handlers.has(method);
    }
}

class DeferredAcknowledgementClient extends FakeClient {
    private resolveAcknowledgement: ((response: any) => void) | null = null;

    public override async sendRequest(method: string, params?: any, timeoutMs?: number): Promise<any> {
        this.requests.push({ method, params, timeoutMs });
        if (method === 'analyze_heap') {
            return new Promise(resolve => { this.resolveAcknowledgement = resolve; });
        }
        if (method === 'cancel_analysis') {
            return { cancelled: true };
        }
        throw new Error(`Unexpected request: ${method}`);
    }

    public acknowledge(requestId: number): void {
        this.resolveAcknowledgement?.({ status: 'processing', request_id: requestId });
    }
}

class FlakyCancellationClient extends FakeClient {
    private cancellationAttempts = 0;

    public override async sendRequest(method: string, params?: any, timeoutMs?: number): Promise<any> {
        this.requests.push({ method, params, timeoutMs });
        if (method === 'analyze_heap') {
            return { status: 'processing', request_id: 42 };
        }
        if (method === 'cancel_analysis') {
            this.cancellationAttempts++;
            if (this.cancellationAttempts === 1) {
                throw new Error('temporary cancellation failure');
            }
            return { cancelled: true };
        }
        throw new Error(`Unexpected request: ${method}`);
    }
}

class ManualTimer implements AnalysisTimer {
    private nextId = 1;
    private readonly callbacks = new Map<number, () => void>();
    public readonly delays: number[] = [];

    public setTimeout(callback: () => void, delayMs: number): unknown {
        const id = this.nextId++;
        this.delays.push(delayMs);
        this.callbacks.set(id, callback);
        return id;
    }

    public clearTimeout(handle: unknown): void {
        this.callbacks.delete(handle as number);
    }

    public fireNext(): void {
        const next = this.callbacks.entries().next();
        if (!next.done) {
            const [id, callback] = next.value;
            this.callbacks.delete(id);
            callback();
        }
    }

    public get pendingCount(): number {
        return this.callbacks.size;
    }
}

function callbacks(overrides: Partial<AnalysisSessionCallbacks> = {}): AnalysisSessionCallbacks {
    return {
        onProgress: () => undefined,
        onLongRunning: async () => 'continue',
        ...overrides
    };
}

async function drainMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

test('buffers cancellation until the webview is ready and delivers it once', () => {
    const state = { webviewReady: false, pendingWebviewMessage: null as any };
    const posted: any[] = [];
    const cancellation = { command: 'analysisCancelled' };

    const delivery = deliverOrBufferWebviewMessage(
        state,
        cancellation,
        message => posted.push(message)
    );

    assert.equal(delivery, 'buffered');
    assert.equal(posted.length, 0);
    assert.equal(state.pendingWebviewMessage, cancellation);

    const flushed = markWebviewReadyAndFlush(state, message => posted.push(message));
    assert.equal(flushed, cancellation);
    assert.deepEqual(posted, [cancellation]);
    assert.equal(state.pendingWebviewMessage, null);

    assert.equal(markWebviewReadyAndFlush(state, message => posted.push(message)), null);
    assert.deepEqual(posted, [cancellation], 'a terminal message must not be delivered twice');
});

test('posts a terminal analysis message immediately when the webview is ready', () => {
    const state = { webviewReady: true, pendingWebviewMessage: null as any };
    const posted: any[] = [];
    const completion = { command: 'analysisComplete' };

    const delivery = deliverOrBufferWebviewMessage(
        state,
        completion,
        message => posted.push(message)
    );

    assert.equal(delivery, 'posted');
    assert.deepEqual(posted, [completion]);
    assert.equal(state.pendingWebviewMessage, null);
});

test('delivers a successful result after the long-running warning', async () => {
    const client = new FakeClient();
    const timer = new ManualTimer();
    let warningCount = 0;
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 300_000 },
        callbacks({
            onLongRunning: async () => {
                warningCount++;
                return 'continue';
            }
        }),
        timer
    );

    const resultPromise = session.run();
    await drainMicrotasks();
    timer.fireNext();
    await drainMicrotasks();

    assert.equal(warningCount, 1);
    assert.equal(client.hasHandler('heap_analysis_complete'), true,
        'a warning must not detach the completion listener');

    client.emit('heap_analysis_complete', {
        request_id: 42,
        status: 'completed',
        summary: { total_instances: 1 }
    });

    const result = await resultPromise;
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') {
        assert.fail(`Expected completed result, got ${result.status}`);
    }
    assert.equal(result.result.summary.total_instances, 1);
    assert.equal(client.hasHandler('heap_analysis_complete'), false);
});

test('does not schedule a warning when the setting is disabled', async () => {
    const client = new FakeClient();
    const timer = new ManualTimer();
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 0 },
        callbacks(),
        timer
    );

    const resultPromise = session.run();
    await drainMicrotasks();
    assert.equal(timer.pendingCount, 0);

    client.emit('heap_analysis_complete', { request_id: 42, status: 'completed' });
    assert.equal((await resultPromise).status, 'completed');
});

test('explicit cancellation waits for the backend terminal notification', async () => {
    const client = new FakeClient();
    const timer = new ManualTimer();
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 300_000 },
        callbacks(),
        timer
    );

    const resultPromise = session.run();
    await drainMicrotasks();
    await session.cancel();

    assert.equal(client.requests.some(request => request.method === 'cancel_analysis'), true);
    assert.equal(client.hasHandler('heap_analysis_complete'), true,
        'cancellation acknowledgement is not the terminal analysis result');

    client.emit('heap_analysis_complete', {
        request_id: 42,
        status: 'error',
        error: 'Heap analysis failed: Analysis cancelled'
    });

    assert.equal((await resultPromise).status, 'cancelled');
    assert.equal(client.hasHandler('heap_analysis_complete'), false);
});

test('cancellation requested before acknowledgement is sent after the request ID arrives', async () => {
    const client = new DeferredAcknowledgementClient();
    const timer = new ManualTimer();
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 300_000 },
        callbacks(),
        timer
    );

    const resultPromise = session.run();
    await drainMicrotasks();
    await session.cancel();
    assert.equal(client.requests.filter(request => request.method === 'cancel_analysis').length, 0);

    client.acknowledge(77);
    await drainMicrotasks();
    const cancellation = client.requests.find(request => request.method === 'cancel_analysis');
    assert.deepEqual(cancellation?.params, {
        path: '/tmp/large.hprof',
        analysis_request_id: 77
    });

    client.emit('heap_analysis_complete', { request_id: 77, status: 'cancelled' });
    assert.equal((await resultPromise).status, 'cancelled');
});

test('the warning can request explicit cancellation', async () => {
    const client = new FakeClient();
    const timer = new ManualTimer();
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 300_000 },
        callbacks({ onLongRunning: async () => 'cancel' }),
        timer
    );

    const resultPromise = session.run();
    await drainMicrotasks();
    timer.fireNext();
    await drainMicrotasks();

    assert.equal(client.requests.some(request => request.method === 'cancel_analysis'), true);
    client.emit('heap_analysis_complete', {
        request_id: 42,
        status: 'error',
        error: 'Analysis cancelled'
    });
    assert.equal((await resultPromise).status, 'cancelled');
});

test('a failed cancellation remains attached and can be retried', async () => {
    const client = new FlakyCancellationClient();
    const timer = new ManualTimer();
    let cancellationErrors = 0;
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 300_000 },
        callbacks({ onCancellationError: () => { cancellationErrors++; } }),
        timer
    );

    const resultPromise = session.run();
    await drainMicrotasks();
    await session.cancel();
    assert.equal(cancellationErrors, 1);
    assert.equal(client.hasHandler('heap_analysis_complete'), true);

    await session.cancel();
    assert.equal(client.requests.filter(request => request.method === 'cancel_analysis').length, 2);

    client.emit('heap_analysis_complete', { request_id: 42, status: 'completed' });
    assert.equal((await resultPromise).status, 'completed');
});

test('accepts the server cancelled terminal status', async () => {
    const client = new FakeClient();
    const timer = new ManualTimer();
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 0 },
        callbacks(),
        timer
    );

    const resultPromise = session.run();
    await drainMicrotasks();
    await session.cancel();
    client.emit('heap_analysis_complete', { request_id: 42, status: 'cancelled' });

    assert.equal((await resultPromise).status, 'cancelled');
});

test('ignores completion notifications from a different analysis request', async () => {
    const client = new FakeClient();
    const timer = new ManualTimer();
    let ignored = 0;
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 0 },
        callbacks({ onIgnoredNotification: () => { ignored++; } }),
        timer
    );

    const resultPromise = session.run();
    await drainMicrotasks();
    client.emit('heap_analysis_complete', { request_id: 99, status: 'completed' });

    assert.equal(ignored, 1);
    assert.equal(client.hasHandler('heap_analysis_complete'), true);

    client.emit('heap_analysis_complete', { request_id: 42, status: 'completed' });
    assert.equal((await resultPromise).status, 'completed');
});

test('ignores progress notifications from a different analysis request', async () => {
    const client = new FakeClient();
    const timer = new ManualTimer();
    const stages: string[] = [];
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 0 },
        callbacks({ onProgress: params => stages.push(params.stage) }),
        timer
    );

    const resultPromise = session.run();
    await drainMicrotasks();
    client.emit('heap_analysis_progress', { request_id: 99, stage: 'wrong' });
    client.emit('heap_analysis_progress', { request_id: 42, stage: 'loading' });
    assert.deepEqual(stages, ['loading']);

    client.emit('heap_analysis_complete', { request_id: 42, status: 'completed' });
    await resultPromise;
});

test('buffers correlated notifications until acknowledgement and rejects stale ones', async () => {
    const client = new DeferredAcknowledgementClient();
    const timer = new ManualTimer();
    let ignored = 0;
    const stages: string[] = [];
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 0 },
        callbacks({
            onProgress: params => stages.push(params.stage),
            onIgnoredNotification: () => { ignored++; }
        }),
        timer
    );

    const resultPromise = session.run();
    client.emit('heap_analysis_progress', { request_id: 99, stage: 'stale' });
    client.emit('heap_analysis_progress', { request_id: 77, stage: 'loading' });
    client.emit('heap_analysis_complete', { request_id: 99, status: 'completed' });
    client.emit('heap_analysis_complete', { request_id: 77, status: 'completed' });

    assert.deepEqual(stages, []);
    client.acknowledge(77);
    assert.equal((await resultPromise).status, 'completed');
    assert.deepEqual(stages, ['loading']);
    assert.equal(ignored, 2);
});

test('server exit rejects the session and cleans up listeners', async () => {
    const client = new FakeClient();
    const timer = new ManualTimer();
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 300_000 },
        callbacks(),
        timer
    );

    const resultPromise = session.run();
    await drainMicrotasks();
    session.serverExited(new Error('server exited'));

    await assert.rejects(resultPromise, /server exited/);
    assert.equal(client.hasHandler('heap_analysis_complete'), false);
    assert.equal(timer.pendingCount, 0);
});

test('disposing an editor resolves the session without reporting an error', async () => {
    const client = new FakeClient();
    const timer = new ManualTimer();
    const session = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 300_000 },
        callbacks(),
        timer
    );

    const resultPromise = session.run();
    await drainMicrotasks();
    session.dispose();

    assert.equal((await resultPromise).status, 'disposed');
    assert.equal(client.hasHandler('heap_analysis_complete'), false);
    assert.equal(timer.pendingCount, 0);
});

test('a retry session re-registers listeners after the previous session completed', async () => {
    const client = new FakeClient();
    const first = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 0 },
        callbacks()
    );

    const firstResult = first.run();
    await drainMicrotasks();
    client.emit('heap_analysis_complete', { request_id: 42, status: 'completed' });
    assert.equal((await firstResult).status, 'completed');
    assert.equal(client.hasHandler('heap_analysis_complete'), false);

    const retry = new AnalysisSession(
        client,
        '/tmp/large.hprof',
        { longRunningWarningMs: 0 },
        callbacks()
    );
    const retryResult = retry.run();
    await drainMicrotasks();
    assert.equal(client.hasHandler('heap_analysis_complete'), true);

    client.emit('heap_analysis_complete', { request_id: 42, status: 'completed' });
    assert.equal((await retryResult).status, 'completed');
});
