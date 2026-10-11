'use strict';
const net = require('node:net');
function number(row, key) { const value = row?.[key]; if (!Number.isSafeInteger(value) || value < -1)
    throw Error('Invalid metric'); return value; }
function name(row, key) { const value = row?.[key]; if (typeof value !== 'string' || value.length > 2048)
    throw Error('Invalid metric label'); return value; }
function metrics(raw) {
    const safe = Object.fromEntries(['timestamp', 'heapUsed', 'heapMax', 'heapCommitted', 'nonHeapUsed', 'nonHeapCommitted', 'threadCount', 'daemonThreadCount', 'uptime'].map(k => [k, number(raw, k)]));
    for (const key of ['gcCollectors', 'memoryPools']) {
        if (!Array.isArray(raw?.[key]) || raw[key].length > 100)
            throw Error('Invalid metric rows');
        safe[key] = raw[key].map(row => key === 'gcCollectors' ? { name: name(row, 'name'), collectionCount: number(row, 'collectionCount'), collectionTimeMs: number(row, 'collectionTimeMs') } : { name: name(row, 'name'), type: name(row, 'type'), used: number(row, 'used'), max: number(row, 'max'), committed: number(row, 'committed') });
    }
    return safe;
}
function histogram(rows) { if (!Array.isArray(rows) || rows.length > 50000)
    throw Error('Invalid histogram'); return rows.map(row => ({ className: name(row, 'className'), instanceCount: number(row, 'instanceCount'), totalBytes: number(row, 'totalBytes') })); }
class Monitor {
    constructor(send) { this.send = send; this.closed = false; }
    connect(host, port) {
        if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535)
            throw Error('Use a loopback JVM-agent address (or local tunnel)');
        this.socket = net.createConnection({ host, port });
        let buffer = '';
        this.socket.setEncoding('utf8');
        this.socket.setTimeout(35000);
        this.connectTimer = setTimeout(() => this.fail(), 5000);
        this.socket.on('connect', () => { clearTimeout(this.connectTimer); if (this.closed)
            return; this.send({ command: 'monitorConnected' }); this.poll = setInterval(() => { if (this.histPending)
            return; this.write('get_metrics'); }, 2000); this.write('get_metrics'); });
        this.socket.on('data', chunk => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > 1024 * 1024)
                return this.fail();
            let end;
            while ((end = buffer.indexOf('\n')) !== -1) {
                let frame;
                try {
                    frame = JSON.parse(buffer.slice(0, end));
                }
                catch {
                    return this.fail();
                }
                buffer = buffer.slice(end + 1);
                try {
                    if (frame.type === 'metrics')
                        this.send({ command: 'monitorMetrics', data: metrics(frame.data) });
                    else if (frame.type === 'histogram' && this.histPending) {
                        this.histPending = false;
                        clearTimeout(this.histTimer);
                        this.send({ command: 'monitorHistogram', data: histogram(frame.data) });
                    }
                    else if (frame.type === 'error' || !['pong', 'histogram'].includes(frame.type))
                        this.fail();
                }
                catch {
                    return this.fail();
                }
            }
        });
        for (const event of ['error', 'timeout', 'end'])
            this.socket.on(event, () => this.fail());
    }
    write(command) { if (!this.closed)
        this.socket.write(JSON.stringify({ command }) + '\n'); }
    histogram() { if (this.closed || this.histPending)
        return; this.histPending = true; this.histTimer = setTimeout(() => this.fail(), 30000); this.write('get_histogram'); }
    fail() { if (this.closed)
        return; this.send({ command: 'monitorError', message: 'Agent unavailable or malformed response. Reconnect.' }); this.close(); }
    close() { if (this.closed)
        return; this.closed = true; clearInterval(this.poll); clearTimeout(this.histTimer); clearTimeout(this.connectTimer); this.socket?.destroy(); this.send({ command: 'monitorDisconnected' }); }
}
module.exports = { Monitor, metrics, histogram };
