'use strict';
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Rpc } = require('./rpc.cjs');
const { requestId, objectId } = require('./guards.cjs');
const capabilities = ["object-actions", "consent-actions", "source-actions", "ai-actions", "snapshot-actions", "export-actions", "monitor-actions", "telemetry-actions"].map(name => require('./' + name + '.cjs'));
const rename = { summary: 'summary', top_objects: 'topObjects', top_layers: 'topLayers', class_histogram: 'classHistogram', leak_suspects: 'leakSuspects', object_leak_suspects: 'objectLeakSuspects', waste_analysis: 'wasteAnalysis' };
// Immutable compact snapshots, not a second heap graph or comparator.
function snapshot(raw) {
    const summary = Object.fromEntries(['total_heap_size', 'reachable_heap_size', 'total_instances', 'total_classes', 'total_arrays', 'total_gc_roots'].map(k => [k, raw.summary[k]]));
    const waste = Object.fromEntries(['total_wasted_bytes', 'waste_percentage', 'duplicate_string_wasted_bytes', 'empty_collection_wasted_bytes', 'over_allocated_wasted_bytes', 'boxed_primitive_wasted_bytes'].map(k => [k, raw.waste_analysis?.[k] || 0]));
    const value = { summary, class_histogram: raw.class_histogram, leak_suspects: raw.leak_suspects, waste_analysis: waste };
    if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024)
        throw Error('Comparison metadata exceeds 8 MiB');
    return value;
}
class Session {
    constructor(host, file) {
        this.host = host;
        this.file = file;
        this.id = crypto.randomUUID();
        this.generation = 0;
        this.events = [];
        this.seq = 0;
        this.eventBytes = 0;
        this.state = 'idle';
        this.raw = null;
        this.history = [];
        this.config = null;
        this.chatGrant = null;
        this.pendingConsent = null;
        this.activeAi = null;
        this.actionContext = new AsyncLocalStorage();
        // New host capabilities extend this registry instead of changing analysis classes.
        this.commands = new Map(Object.entries({ ready: m => this.ready(), retryAnalysis: m => this.analyze(), cancelAnalysis: m => this.cancel(), closeDump: m => this.close(), shutdown: m => this.host.shutdown() }));
        for (const capability of capabilities)
            capability.install(this);
    }
    purge() { this.events = []; this.eventBytes = 0; }
    attach(view) { if (typeof view !== 'string' || !/^[a-f0-9-]{36}$/.test(view))
        throw Error('Invalid page session'); if (this.view !== view) {
        this.view = view;
        this.stopAi();
        this.monitor?.close();
        this.monitor = null;
        this.chatGrant = null;
        this.purge();
    } }
    emit(command, data = {}) {
        const action = this.actionContext.getStore();
        if (action && (action.view !== this.view || action.generation !== this.generation))
            return;
        const message = { command, ...data };
        try { require('./telemetry-actions.cjs').observe(this,command,data); } catch { /* Diagnostics cannot fail UI delivery. */ }
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (bytes > 64 * 1024 * 1024)
            throw Error('UI response exceeds 64 MiB');
        this.events.push({ seq: ++this.seq, message, bytes });
        this.eventBytes += bytes;
        while (this.events.length > 256 || this.eventBytes > 64 * 1024 * 1024) {
            this.eventBytes -= this.events.shift().bytes;
        }
    }
    async dispatch(m) {
        if (!m || typeof m !== 'object' || Array.isArray(m) || !this.commands.has(m.command) || this.state === 'closed' && !['ready', 'shutdown'].includes(m.command))
            throw Error('Unsupported action');
        const action = this.commands.get(m.command);
        if (['ready', 'retryAnalysis', 'cancelAnalysis', 'closeDump', 'shutdown'].includes(m.command))
            await this.actionContext.run(undefined, () => action(m));
        else
            await this.actionContext.run({ view: this.view, generation: this.generation }, () => action(m));
    }
    status(message) { this.emit('browserStatus', { message }); }
    ready() {
        if (this.raw) {
            this.emit('analysisComplete', { ...Object.fromEntries(Object.entries(rename).map(([a, b]) => [b, this.raw[a]])), displayName: this.file.label });
            this.status('READY | server PID ' + this.rpc?.child.pid);
            this.emit('aiHistory', { messages: this.history });
        }
        else if (this.state === 'idle')
            this.analyze();
        else
            this.status(this.state === 'closed' ? 'Dump closed. Start a new CLI session to reopen.' : this.state.toUpperCase() + ' | server PID ' + (this.rpc?.child.pid || 'pending'));
    }
    async analyze() {
        if (['loading', 'queued'].includes(this.state))
            return;
        const generation = ++this.generation;
        this.stopAi();
        this.chatGrant = null;
        this.history = [];
        this.monitor?.close();
        this.raw = null;
        this.snapshot = null;
        this.rpc?.close();
        this.purge();
        this.state = 'queued';
        this.host.changed();
        this.emit('analysisProgress', { stage: 'loading', phase: 1, totalPhases: 4, fileMetadata: { file_size: this.file.size } });
        this.status('Waiting for analysis slot. Other dumps remain available.');
        await this.host.slot(async () => {
            if (generation !== this.generation || this.state === 'closed')
                return;
            this.state = 'loading';
            this.rpc = new Rpc(this.host.server, this.host.legacy);
            const rpc = this.rpc;
            this.status('ANALYZING | server PID ' + rpc.child.pid);
            rpc.on('unavailable', () => { if (generation !== this.generation)
                return; this.state = 'failed'; this.raw = null; this.snapshot = null; this.stopAi(); this.host.changed(); this.emit('serverCrashed', { message: 'Analysis server unavailable. Retry starts a new server.' }); this.status('SERVER UNAVAILABLE | Retry'); this.finishAnalysis?.(); });
            let finish;
            const completed = new Promise(resolve => { finish = resolve; });
            this.finishAnalysis = finish;
            rpc.on('notification', message => {
                if (generation !== this.generation || this.state !== 'loading' || message.params?.request_id !== this.analysisId)
                    return;
                const p = message.params;
                if (message.method === 'heap_analysis_progress')
                    this.emit('analysisProgress', { stage: p.stage, phase: p.phase, totalPhases: p.total_phases, summary: p.summary });
                if (message.method === 'heap_analysis_complete') {
                    if (p.status === 'completed') {
                        this.raw = p;
                        this.state = 'ready';
                        try {
                            this.snapshot = snapshot(p);
                        }
                        catch {
                            this.snapshot = null;
                            this.status('READY. Comparison metadata exceeds its limit.');
                        }
                        this.ready();
                        this.host.changed();
                    }
                    else {
                        this.state = p.status === 'cancelled' ? 'cancelled' : 'failed';
                        this.raw = null;
                        this.snapshot = null;
                        this.emit(p.status === 'cancelled' ? 'analysisCancelled' : 'serverCrashed', { message: 'Analysis failed or was cancelled. Retry.' });
                        this.status(this.state.toUpperCase() + ' | Retry');
                    }
                    finish();
                }
            });
            try {
                const started = rpc.request('analyze_heap', { path: this.file.path }, 30000);
                this.analysisId = started.id;
                await started.promise;
                await completed;
            }
            catch {
                if (generation === this.generation) {
                    this.state = 'failed';
                    this.emit('serverCrashed', { message: 'Server did not acknowledge analysis. Retry.' });
                    rpc.close();
                }
                finish();
            }
            finally {
                if (this.finishAnalysis === finish)
                    this.finishAnalysis = null;
            }
        });
    }
    async cancel() {
        if (this.state === 'queued') {
            this.generation++;
            this.state = 'cancelled';
            this.emit('analysisCancelled');
            this.status('CANCELLED | Retry');
            return;
        }
        if (this.state === 'loading')
            await this.rpc.call('cancel_analysis', { path: this.file.path, analysis_request_id: this.analysisId }).catch(() => { });
    }
    async engine(method, params) { if (this.state !== 'ready' || !this.rpc)
        throw Error('Wait for analysis or Retry.'); const gen = this.generation; const result = await this.rpc.call(method, { ...params, path: this.file.path }); if (gen !== this.generation || this.state !== 'ready')
        throw Error('Analysis changed. Repeat the action.'); return result; }
    close() { this.generation++; this.state = 'closed'; this.stopAi(); this.config = null; this.history = []; this.raw = null; this.snapshot = null; this.rpc?.close(); this.monitor?.close(); this.finishAnalysis?.(); this.purge(); this.host.changed(); this.emit('analysisCancelled'); this.status('Dump closed; server stopped. Other dumps are unaffected.'); }
}
module.exports = { Session, snapshot, requestId, objectId };
