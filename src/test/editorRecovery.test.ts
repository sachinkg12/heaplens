import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { editorHarness, FakeServer, settle } from './editorHarness';

test('retired tree child results and failures cannot reuse a replacement analysis denominator', async () => {
    for (const failed of [false, true]) {
        const clients: FakeServer[] = [], host = editorHarness(() => { const c = new FakeServer(); clients.push(c); return c; }), view = host.panel();
        try {
            await host.open('/tmp/tree-percentage-retry.hprof', view); await view.send({ command: 'ready' });
            let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
            clients[0].sendRequest = async () => new Promise((yes, no) => { resolve = yes; reject = no; });
            const old = view.send({ command: 'getChildren', objectId: 512 });
            await settle(); await view.send({ command: 'analyzeRetained' });
            const count = view.messages.length;
            if (failed) { reject(new Error('retired tree request')); }
            else { resolve([{ object_id: 513, retained_size: 100 }]); }
            await old; assert.equal(view.messages.length, count);
        } finally { host.provider.dispose(); }
    }
});

test('incident reports preserve zero reachable heap and never substitute total heap', async () => {
    const host = editorHarness(() => new FakeServer()), view = host.panel();
    try {
        await host.open('/tmp/report-percentage.hprof', view); await view.send({ command: 'ready' });
        const data = host.provider.getAnalysisData(); assert.ok(data); assert.ok(data.summary);
        const summary = data.summary;
        for (const value of [0, undefined, NaN, Infinity]) {
            Object.assign(summary, { total_instances: 1, total_classes: 1, total_arrays: 0, total_gc_roots: 1,
                total_heap_size: 1024, reachable_heap_size: value });
            await view.send({ command: 'copyReport' });
            assert.match(host.clipboard.at(-1) || '', value === 0
                ? /Reachable Heap Size:\*\* 0 B/ : /Reachable Heap Size:\*\* Not calculated/);
        }
    } finally { host.provider.dispose(); }
});

test('editor paints before its one analysis, streams snapshots, and rejects stale progress', async () => {
    const client=new FakeServer();client.autoComplete=false;
    const host=editorHarness(()=>client), view=host.panel();
    try {
        await host.open('/tmp/staged.hprof',view);
        assert.deepEqual(view.events, ['receiver','html'], 'Ready receiver must precede HTML loading');
        assert.equal(host.provider.getAnalysisData(),null);
        assert.equal(client.requests.length,0,'CPU work must wait for the painted webview');
        await view.send({command:'ready'});
        await view.send({command:'ready'});
        const progress=client.handlers.get('heap_analysis_progress');
        assert.ok(progress);
        progress({request_id:1,stage:'shallow_ready',snapshot:{kind:'shallow',summary:{reachable_heap_size:null},class_histogram:[]}});
        progress({request_id:1,stage:'edges'});
        assert.equal(view.messages.at(-1).stage,'edges');
        assert.equal(view.messages.find(m=>m.stage==='shallow_ready').snapshot.kind,'shallow');
        await view.send({command:'executeQuery',query:'SELECT * FROM instances'});
        assert.equal(client.requests.filter(r=>r.method==='execute_query').length,0);
        const count=view.messages.length;
        progress({request_id:999,stage:'sizing',snapshot:{kind:'records',instances:999}});
        assert.equal(view.messages.length,count);
        client.complete();await settle();
        assert.equal(view.messages.at(-1).command,'analysisComplete');
        assert.equal(client.requests.filter(r=>r.method==='scan_heap').length,0);
        assert.equal(client.requests.filter(r=>r.method==='analyze_heap').length,1);
    } finally {host.provider.dispose();}
});

test('initial server startup failure has visible fallback content instead of a blank editor', async () => {
    const host=editorHarness(()=>{throw new Error('fixture spawn failure');}), view=host.panel();
    try {
        await host.open('/tmp/startup-failure.hprof',view);
        assert.match(view.value.webview.html,/could not start the analysis server/);
        assert.match(view.value.webview.html,/role="alert"/);
    } finally {host.provider.dispose();}
});

test('Waste is requested explicitly, updates editor context and sanitizes a failed retry', async () => {
    const client=new FakeServer(), host=editorHarness(()=>client), view=host.panel();
    try {
        await host.open('/tmp/waste.hprof',view);await view.send({command:'ready'});
        assert.equal(client.requests.filter(r=>r.method==='get_waste_analysis').length,0);
        const send=client.sendRequest.bind(client);
        const waste={total_wasted_bytes:42,waste_percentage:1,duplicate_string_wasted_bytes:42,empty_collection_wasted_bytes:0,duplicate_strings:[],empty_collections:[]};
        client.sendRequest=async(method,params)=>method==='get_waste_analysis'?waste:send(method,params);
        await view.send({command:'calculateWaste',requestId:'waste-1',path:'/untrusted/dump'});
        assert.equal(view.messages.at(-1).command,'wasteResult');
        assert.equal(host.provider.getAnalysisData()?.wasteAnalysis,waste);
        client.sendRequest=async()=>{throw new Error('PRIVATE failure');};
        await view.send({command:'calculateWaste',requestId:'waste-2'});
        assert.equal(view.messages.at(-1).command,'wasteError');
        assert.doesNotMatch(JSON.stringify(view.messages.at(-1)),/PRIVATE/);
    } finally {host.provider.dispose();}
});

test('a retired Waste response cannot overwrite a replacement analysis', async () => {
    const clients:FakeServer[]=[],host=editorHarness(()=>{const c=new FakeServer();clients.push(c);return c;}),view=host.panel();
    try {
        await host.open('/tmp/waste-retry.hprof',view);await view.send({command:'ready'});
        let resolve!: (value:any)=>void;
        clients[0].sendRequest=async()=>new Promise(r=>{resolve=r;});
        const pending=view.send({command:'calculateWaste',requestId:'retired-waste'});
        await settle();await view.send({command:'analyzeRetained'});
        resolve({total_wasted_bytes:999});await pending;await settle();
        assert.equal(view.messages.filter(m=>m.requestId==='retired-waste').length,0);
        assert.equal(host.provider.getAnalysisData()?.wasteAnalysis,undefined);
    } finally {host.provider.dispose();}
});

test('Waste waits for content analysis instead of inheriting the short RPC timeout', async () => {
    const client = new FakeServer(), host = editorHarness(() => client), view = host.panel();
    try {
        await host.open('/tmp/waste-timeout.hprof', view); await view.send({ command: 'ready' });
        await view.send({ command: 'calculateWaste', requestId: 'long-waste' });
        const request = client.requests.find(r => r.method === 'get_waste_analysis');
        assert.equal(request?.timeoutMs, 0);
        assert.equal(view.messages.at(-1).command, 'wasteResult');
    } finally { host.provider.dispose(); }
});

test('Quick Scan initial mode gates graph actions; only explicit escalation runs full analysis', async () => {
    const clients:FakeServer[]=[];
    const host=editorHarness(()=>{const c=new FakeServer();clients.push(c);return c;},'shallow');
    const view=host.panel();
    try {
        await host.open('/tmp/shallow.hprof',view); await view.send({command:'ready'});
        assert.equal(clients[0].requests[0].method,'scan_heap');
        assert.equal(view.messages.at(-1).command,'shallowScanComplete');
        assert.equal(host.provider.getAnalysisData(),null);
        const before=clients[0].requests.length;
        for(const command of ['executeQuery','inspectObject','gcRootPath','fixWithAi','sendChatMessage'])await view.send({command,objectId:512});
        assert.equal(clients[0].requests.length,before);
        await view.send({command:'analyzeRetained'});
        assert.equal(clients[1].requests.at(-1)?.method,'analyze_heap');
        assert.equal(view.messages.at(-1).command,'analysisComplete');
        await view.send({command:'executeQuery',query:'SELECT * FROM instances LIMIT 1'});
        assert.equal(clients[1].requests.at(-1)?.method,'execute_query');
        await view.send({command:'quickScan'});
        assert.equal(view.messages.at(-1).command,'shallowScanComplete');
        assert.equal(host.provider.getAnalysisData(),null);
    }finally {host.provider.dispose();}
});

test('mode changes retire in-flight full-analysis reads before shallow results are shown', async () => {
    const clients:FakeServer[]=[];
    const host=editorHarness(()=>{const c=new FakeServer();clients.push(c);return c;});const view=host.panel();
    try {
        await host.open('/tmp/mode.hprof',view);await view.send({command:'ready'});
        let reply!: (value:any)=>void;
        clients[0].sendRequest=async()=>new Promise(resolve=>{reply=resolve;});
        const old=view.send({command:'executeQuery',query:'SELECT * FROM instances'});
        await view.send({command:'quickScan'});assert.equal(clients.length,2);assert.equal(clients[0].isDisposed,true);
        const count=view.messages.length;reply({rows:[[512]]});await old;
        assert.equal(view.messages.length,count);assert.equal(view.messages.at(-1).command,'shallowScanComplete');
    }finally{host.provider.dispose();}
});

test('crash Retry repeats Quick Scan without silently escalating', async () => {
    const clients:FakeServer[]=[];
    const host=editorHarness(()=>{const c=new FakeServer();clients.push(c);return c;},'shallow');
    const view=host.panel();
    try {
        await host.open('/tmp/shallow.hprof',view); await view.send({command:'ready'});
        clients[0].die(); await view.send({command:'retryAnalysis'});
        assert.equal(clients.length,2);assert.equal(clients[1].requests[0].method,'scan_heap');
        assert.equal(view.messages.at(-1).command,'shallowScanComplete');
    }finally {host.provider.dispose();}
});

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
    const host = editorHarness(() => { const c = new FakeServer(); c.autoComplete = clients.length > 0; clients.push(c); return c; });
    const view = host.panel();
    try {
        clients.length = 0;
        const opening = host.open('/tmp/stale.hprof', view);
        await view.send({ command: 'ready' });
        const oldProgress = clients[0].handlers.get('heap_analysis_progress');
        const oldExit = clients[0].onProcessExit;
        assert.ok(oldProgress); assert.ok(oldExit);
        clients[0].complete(); await settle();
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

test('crash before ready prevents initial analysis and delivers a recoverable crash message', async () => {
    const clients: FakeServer[] = [];
    const host = editorHarness(() => { const c = new FakeServer(); clients.push(c); return c; });
    const view = host.panel();
    try {
        await host.open('/tmp/buffer.hprof', view);
        clients[0].die();
        await view.send({ command: 'ready' });
        assert.equal(clients[0].requests.length, 0);
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
