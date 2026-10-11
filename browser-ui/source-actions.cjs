'use strict';
const { requestId } = require('./guards.cjs');
const actions = {
    async selectSource(name, signal) {
        const matches = await this.host.sources.find(name);
        if (!matches.length)
            throw Error('No matching Java file under --source-root. Add the source folder when launching.');
        if (matches.length === 1)
            return matches[0];
        const selected = await this.consent('Choose source', 'Several files match. Select a local file; no network request is made.', matches.map((f, i) => [f.label + ' (root ' + f.rootIndex + ')', String(i)]).concat([['Cancel', null]]), signal);
        return selected === null ? null : matches[Number(selected)];
    },
    async source(m) {
        const id = requestId(m), gen = this.generation;
        try {
            if (this.state !== 'ready')
                throw Error();
            const file = await this.selectSource(m.className);
            if (gen !== this.generation)
                return;
            if (!file) {
                this.emit('sourceNavigationResult', { requestId: id, className: m.className, status: 'cancelled' });
                return;
            }
            const text = await this.host.sources.read(file);
            if (gen !== this.generation)
                return;
            this.emit('browserSource', { label: file.label, text });
            this.emit('sourceNavigationResult', { requestId: id, className: m.className, status: 'opened' });
        }
        catch {
            this.emit('sourceNavigationResult', { requestId: id, className: m.className, status: 'not-found' });
            this.emit('localActionStatus', { message: 'Source unavailable. Supply --source-root. Dependency-JAR lookup/decompilation is not bundled.' });
        }
    }
};
module.exports.install = session => { for (const [name, action] of Object.entries(actions))
    session[name] = action.bind(session); session.commands.set('openProjectSource', m => session.source(m)); };
