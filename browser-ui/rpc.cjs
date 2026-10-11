'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
// Preserve wide integers as decimal strings. Existing renderer actions reject
// unsafe IDs rather than selecting an adjacent object after JSON rounding.
function parseExact(text) {
    let out = '', quoted = false, escaped = false;
    for (let i = 0; i < text.length;) {
        const c = text[i];
        if (quoted) {
            out += c;
            i++;
            if (escaped)
                escaped = false;
            else if (c === '\\')
                escaped = true;
            else if (c === '"')
                quoted = false;
            continue;
        }
        if (c === '"') {
            quoted = true;
            out += c;
            i++;
            continue;
        }
        if (c === '-' || /[0-9]/.test(c)) {
            const match = text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
            if (!match)
                throw Error('Invalid JSON');
            const n = match[0];
            out += !/[.eE]/.test(n) && (BigInt(n) > 9007199254740991n || BigInt(n) < -9007199254740991n) ? JSON.stringify(n) : n;
            i += n.length;
        }
        else {
            out += c;
            i++;
        }
    }
    return JSON.parse(out);
}
class Rpc extends EventEmitter {
    constructor(executable, legacy = false) {
        super();
        this.pending = new Map();
        this.seq = 0;
        this.buffer = '';
        this.closed = false;
        this.child = spawn(executable, legacy ? ['--legacy'] : [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.child.stderr.on('data', () => { }); // Never forward raw heap paths/parser bytes.
        this.child.stdin.on('error', () => this.fail());
        this.child.on('error', () => this.fail());
        this.child.on('exit', () => this.fail());
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', text => {
            if (this.closed)
                return;
            this.buffer += text;
            if (Buffer.byteLength(this.buffer) > 64 * 1024 * 1024)
                return this.fail();
            let end;
            while ((end = this.buffer.indexOf('\n')) !== -1) {
                const line = this.buffer.slice(0, end);
                this.buffer = this.buffer.slice(end + 1);
                try {
                    const message = parseExact(line);
                    if (message.id !== undefined) {
                        const p = this.pending.get(message.id);
                        if (!p)
                            continue;
                        this.pending.delete(message.id);
                        clearTimeout(p.timer);
                        message.error ? p.reject(Error('Engine request failed. Check syntax or retry.')) : p.resolve(message.result);
                    }
                    else if (message.method)
                        this.emit('notification', message);
                }
                catch {
                    return this.fail();
                }
            }
        });
    }
    request(method, params, timeout = 30000) {
        if (this.closed)
            return Promise.reject(Error('Server unavailable. Retry.'));
        const id = ++this.seq;
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Engine request did not reply. Retry or simplify the query.')); }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(serialize({ jsonrpc: '2.0', id, method, params }, method === 'compare_snapshots') + '\n');
        });
        return { id, promise };
    }
    call(method, params, timeout) { const r = this.request(method, params, timeout); return r.promise || r; }
    fail() { if (this.closed)
        return; this.closed = true; for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error('Server unavailable. Retry.'));
    } this.pending.clear(); this.child.kill(); this.emit('unavailable'); }
    close() { this.removeAllListeners(); this.fail(); }
}
// Only typed engine numeric fields are emitted as exact unquoted decimals.
// Ordinary heap/user strings (including digits) remain JSON strings.
const integerFields = new Set(['object_id', 'total_heap_size', 'reachable_heap_size', 'total_instances', 'total_classes', 'total_arrays', 'total_gc_roots', 'instance_count', 'shallow_size', 'retained_size', 'total_wasted_bytes', 'duplicate_string_wasted_bytes', 'empty_collection_wasted_bytes', 'over_allocated_wasted_bytes', 'boxed_primitive_wasted_bytes']);
function serialize(value, exact = false, key = '') {
    if (exact && integerFields.has(key) && typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= 18446744073709551615n)
        return value;
    if (Array.isArray(value))
        return '[' + value.map(x => serialize(x, exact)).join(',') + ']';
    if (value && typeof value === 'object')
        return '{' + Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => JSON.stringify(k) + ':' + serialize(v, exact, k)).join(',') + '}';
    return JSON.stringify(value);
}
module.exports = { Rpc, parseExact, serialize };
