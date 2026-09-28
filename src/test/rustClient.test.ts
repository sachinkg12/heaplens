import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { RustClient } from '../rustClient';

function transport() {
    const child = Object.assign(new EventEmitter(), {
        pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        killed: false, kill: () => { child.killed = true; child.emit('exit', null, 'SIGTERM'); return true; }
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const modules = require('module') as any;
    const load = modules._load;
    const filename = require.resolve('../rustClient');
    delete require.cache[filename];
    modules._load = function(request: string, parent: any, main: boolean) {
        return request === 'child_process' ? { spawn: () => child } : load.call(this, request, parent, main);
    };
    try {
        const Client: typeof RustClient = load(filename, module, false).RustClient;
        return { client: new Client('test-only'), child };
    } finally { modules._load = load; }
}

test('unexpected exit marks the client dead before notifying and rejects pending requests', async () => {
    const { client, child } = transport();
    let exits = 0;
    client.onProcessExit = () => { exits++; assert.equal(client.isDisposed, true); };
    const request = client.sendRequest('ping');
    const rejected = assert.rejects(request, /exited/);
    child.emit('exit', null, 'SIGKILL');
    await rejected;
    assert.equal(exits, 1);
});

test('spawn error notifies once even when no exit event arrives', async () => {
    const { client, child } = transport();
    let errors = 0, exits = 0;
    client.onProcessError = error => { errors++; assert.match(error.message, /EACCES/); assert.equal(client.isDisposed, true); };
    client.onProcessExit = () => { exits++; };
    const rejected = assert.rejects(client.sendRequest('ping'), /EACCES/);
    child.emit('error', new Error('spawn EACCES'));
    child.emit('exit', -1, null);
    await rejected;
    assert.equal(errors, 1); assert.equal(exits, 0);
});

test('intentional disposal rejects requests without a crash notification', async () => {
    const { client } = transport();
    let crashes = 0;
    client.onProcessExit = () => { crashes++; };
    const rejected = assert.rejects(client.sendRequest('ping'), /shutdown/);
    client.dispose();
    await rejected;
    assert.equal(crashes, 0);
});

test('malformed JSON is ignored and a later valid reply resolves the same request', async () => {
    const { client, child } = transport();
    try {
        const request = client.sendRequest('ping');
        child.stdout.write('not-json\n');
        child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
        assert.deepEqual(await request, { ok: true });
    } finally { client.dispose(); }
});
