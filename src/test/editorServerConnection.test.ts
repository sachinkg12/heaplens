import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EditorServerConnection, HeartbeatTimer } from '../editorServerConnection';
import { FakeServer, settle } from './editorHarness';

class ManualHeartbeat implements HeartbeatTimer {
    private nextId = 0;
    public callbacks = new Map<number, () => void>();
    public setInterval(callback: () => void): number { this.callbacks.set(++this.nextId, callback); return this.nextId; }
    public clearInterval(id: unknown): void { this.callbacks.delete(id as number); }
    public tick(): void { for (const callback of this.callbacks.values()) { callback(); } }
}

function setup() {
    const timer = new ManualHeartbeat();
    const clients: FakeServer[] = [];
    const failures: number[] = [], deaths: FakeServer[] = [];
    const connection = new EditorServerConnection(() => {
        const c = new FakeServer(); clients.push(c); return c;
    }, { onUnavailable: c => deaths.push(c), onStderr: () => undefined, onHeartbeatFailure: n => failures.push(n) }, timer);
    return { timer, clients, failures, deaths, connection };
}

test('one owner, one heartbeat; old exit cannot retire a replacement', () => {
    const { connection, timer, clients, deaths } = setup();
    const old = connection.connect();
    const delayedExit = old.onProcessExit;
    assert.ok(delayedExit);
    assert.equal(connection.connect(), old);
    old.die();
    assert.equal(timer.callbacks.size, 0);
    const current = connection.connect();
    delayedExit(null, 'SIGKILL');
    assert.equal(connection.isCurrent(current), true);
    assert.equal(clients.length, 2);
    assert.deepEqual(deaths, [old]);
    assert.equal(timer.callbacks.size, 1);
    connection.dispose();
    assert.equal(timer.callbacks.size, 0);
    assert.throws(() => connection.connect(), /closed/);
});

test('a delayed failed ping cannot change replacement health or clear its heartbeat', async () => {
    const { connection, timer, failures } = setup();
    const old = connection.connect();
    let finish!: (ok: boolean) => void;
    old.ping = () => new Promise(resolve => { finish = resolve; });
    timer.tick();
    old.die();
    const current = connection.connect();
    finish(false);
    await settle();
    assert.deepEqual(failures, []);
    assert.equal(timer.callbacks.size, 1);
    current.ping = async () => false;
    timer.tick(); await settle();
    assert.deepEqual(failures, [1]);
    connection.dispose();
});

test('heartbeat is single-flight and live unresponsiveness never triggers a restart', async () => {
    const { connection, timer, clients, failures } = setup();
    const client = connection.connect();
    let pings = 0, finish!: (ok: boolean) => void;
    client.ping = () => { pings++; return new Promise(resolve => { finish = resolve; }); };
    for (let i = 0; i < 10; i++) { timer.tick(); }
    assert.equal(pings, 1);
    finish(false); await settle();
    client.ping = async () => false;
    for (let i = 0; i < 4; i++) { timer.tick(); await settle(); }
    assert.deepEqual(failures, [1, 2, 3, 4, 5]);
    assert.equal(connection.connect(), client);
    assert.equal(clients.length, 1);
    assert.equal(client.isDisposed, false);
    connection.dispose();
});

test('generated connect/death/dispose sequences match a simple ownership oracle', () => {
    let seed = 0x101;
    for (let trial = 0; trial < 100; trial++) {
        const { connection, timer, clients } = setup();
        let expected: FakeServer | null = null, closed = false;
        const stale: Array<() => void> = [];
        for (let step = 0; step < 60; step++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const action = seed % 10;
            if (action < 5 && !closed) {
                const actual = connection.connect();
                if (expected) { assert.equal(actual, expected); }
                expected = actual;
            } else if (action < 8 && expected) {
                const exit = expected.onProcessExit;
                assert.ok(exit);
                stale.push(() => exit(null, 'SIGKILL'));
                expected.die(); expected = null;
            } else if (action === 8) {
                for (const notify of stale) { notify(); }
            } else if (action === 9) {
                connection.dispose(); expected = null; closed = true;
            }
            assert.equal(timer.callbacks.size, expected ? 1 : 0);
            assert.equal(clients.filter(c => !c.isDisposed).length, expected ? 1 : 0);
            for (const client of clients) { assert.equal(connection.isCurrent(client), client === expected); }
        }
        connection.dispose();
    }
});
