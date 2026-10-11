'use strict';
const { requestId } = require('./guards.cjs');
const actions = {
    list(all) { const rows = this.host.available().filter(s => all || s !== this); this.emit(all ? 'allAnalyzedFiles' : 'analyzedFiles', { files: rows.map(s => s.id), labels: Object.fromEntries(rows.map(s => [s.id, s.file.label])) }); },
    async compare(m) {
        const id = requestId(m);
        try {
            const baseline = this.host.sessions.get(m.baselinePath);
            if (!baseline?.snapshot || !this.snapshot || baseline === this)
                throw Error();
            const a = baseline.snapshot, b = this.snapshot;
            const result = await this.engine('compare_snapshots', { baseline: a, current: b, baseline_label: baseline.file.label, current_label: this.file.label });
            if (a !== baseline.snapshot || b !== this.snapshot)
                throw Error();
            this.emit('compareResult', { requestId: id, result, sizeModelsDiffer: JSON.stringify(baseline.raw.summary.size_model) !== JSON.stringify(this.raw.summary.size_model) });
        }
        catch {
            this.emit('compareError', { requestId: id, error: 'Choose two currently analyzed dumps with comparison metadata below 8 MiB.' });
        }
    },
    timeline(m) {
        const id = requestId(m);
        try {
            if (!Array.isArray(m.paths) || m.paths.length < 2 || m.paths.length > 8 || new Set(m.paths).size !== m.paths.length)
                throw Error();
            const selected = m.paths.map(id => { const s = this.host.sessions.get(id); if (!s?.snapshot)
                throw Error(); return s; }).sort((a, b) => a.file.mtime - b.file.mtime);
            const tracked = new Set(selected.flatMap(s => s.snapshot.class_histogram.slice(0, 10).map(x => x.class_name)));
            this.emit('timelineDataResponse', { requestId: id, sizeModelsDiffer: new Set(selected.map(s => JSON.stringify(s.raw.summary.size_model))).size > 1, result: { snapshots: selected.map(s => ({ path: s.file.label, timestamp: s.file.mtime / 1000, summary: s.snapshot.summary, size_model: s.raw.summary.size_model, top_classes: s.snapshot.class_histogram.filter(x => tracked.has(x.class_name)) })) } });
        }
        catch {
            this.emit('timelineError', { requestId: id, error: 'Select 2–8 analyzed dumps. Time order is file modification time, not necessarily capture time.' });
        }
    }
};
module.exports.install = session => { for (const [name, action] of Object.entries(actions))
    session[name] = action.bind(session); for (const [command, handler] of Object.entries({ listAnalyzedFiles: m => session.list(false), listAllAnalyzedFiles: m => session.list(true), compareHeaps: m => session.compare(m), getTimelineData: m => session.timeline(m) }))
    session.commands.set(command, handler); };
