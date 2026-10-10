'use strict';
const crypto = require('node:crypto');
const actions = {
    async consent(title, message, choices, signal) {
        if (this.pendingConsent)
            throw Error('Another approval dialog is open');
        if (signal?.aborted)
            return null;
        const id = crypto.randomUUID(), generation = this.generation, scope = this.config?.scope;
        return new Promise(resolve => {
            const finish = decision => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (this.pendingConsent?.id === id)
                this.pendingConsent = null; resolve(generation === this.generation && scope === this.config?.scope ? decision : null); };
            const abort = () => this.pendingConsent?.id === id && this.pendingConsent.finish(null), timer = setTimeout(abort, 120000);
            this.pendingConsent = { id, finish: decision => { finish(decision); this.emit('browserConsentClosed', { id }); }, values: choices.map(x => x[1]) };
            signal?.addEventListener('abort', abort, { once: true });
            this.emit('browserConsent', { id, title, message, choices });
        });
    },
    decide(m) { if (this.pendingConsent?.id === m.id) {
        const pending = this.pendingConsent;
        pending.finish(pending.values.includes(m.decision) ? m.decision : null);
    } }
};
module.exports.install = session => { for (const [name, action] of Object.entries(actions))
    session[name] = action.bind(session); session.commands.set('browserConsentDecision', m => session.decide(m)); };
