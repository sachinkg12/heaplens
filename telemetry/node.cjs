'use strict';
const https = require('node:https');
const { schema, record, envelope } = require('./contract.cjs');

// No SDK, automatic exceptions, identity tags, redirects, disk queue or retries.
function azureSend(body, done) {
    let finished = false, deadline, request;
    const finish = ok => { if (!finished) { finished = true; clearTimeout(deadline); done(ok); } };
    try {
        request = https.request(schema.endpoint, { method: 'POST', headers: {
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
        } }, response => { response.on('error',()=>finish(false));response.on('end',()=>finish(response.statusCode === 200));response.resume(); });
        request.on('error', () => finish(false));
        deadline = setTimeout(() => { request.destroy(); finish(false); }, 1000);
        deadline.unref();
        request.end(body);
    } catch { finish(false); }
    return () => { request?.destroy(); finish(false); };
}

class Telemetry {
    constructor({ context, level = 'off', disabled = false, send = azureSend }) {
        this.context = context; this.disabled = disabled; this.send = send;
        this.level = 'off'; this.queue = []; this.recent = []; this.job = null;
        this.submitted = 0; this.accepted = 0; this.dropped = 0; this.generation = 0;
        this.setLevel(level);
    }
    setLevel(level) {
        const next = !this.disabled && ['off','error','all'].includes(level) ? level : 'off';
        if (next === this.level) return;
        this.level = next; this.generation++; this.queue.length = 0;
        const retired = this.job; this.job = null; retired?.abort?.();
    }
    track(name, properties, measurements) {
        try {
            const event = record(name, this.context, properties, measurements);
            if (!event) return false;
            this.recent.push(event); if (this.recent.length > 20) this.recent.shift();
            if (this.level === 'off' || (this.level === 'error' && event.category !== 'error')) return true;
            if (this.queue.length >= 16 || this.submitted + this.queue.length >= 256) { this.dropped++; return true; }
            this.queue.push(event); queueMicrotask(() => this.pump()); return true;
        } catch { return false; }
    }
    pump() {
        if (this.job || !this.queue.length || this.level === 'off') return;
        const event = this.queue.shift(), job = { generation: this.generation, abort: null };
        this.job = job; this.submitted++;
        const finish = accepted => {
            if (this.job !== job || job.generation !== this.generation) return;
            if (accepted) this.accepted++;
            this.job = null; queueMicrotask(() => this.pump());
        };
        try { job.abort = this.send(JSON.stringify(envelope(event)), finish); }
        catch { finish(false); }
    }
    report() { return { schemaVersion: 1, level: this.level, submitted: this.submitted, accepted: this.accepted,
        queued: this.queue.length, dropped: this.dropped,
        note: 'Local allowlisted records. HTTP acceptance is not proof of Azure portal visibility. No stable user/session IDs; network services may process IP addresses.',
        events: JSON.parse(JSON.stringify(this.recent)) }; }
    dispose() { this.setLevel('off'); this.recent.length = 0; }
}
module.exports = { Telemetry, azureSend };
