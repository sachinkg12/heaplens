'use strict';
const { Monitor } = require('./monitor.cjs');
const actions = {
    async startMonitor(m) {
        try {
            this.monitor?.close();
            if (!['127.0.0.1', 'localhost', '::1'].includes(m.host) || !Number.isInteger(m.port) || m.port < 1 || m.port > 65535)
                throw Error();
            if (await this.consent('Connect JVM agent', 'Connect to the separately running HeapLens agent at ' + m.host + ':' + m.port + '. It uses an unauthenticated local TCP protocol. Use only your trusted local agent or tunnel.', [['Connect', 'connect'], ['Cancel', null]]) !== 'connect') {
                this.emit('monitorDisconnected');
                return;
            }
            this.monitor = new Monitor(event => this.emit(event.command, event));
            this.monitor.connect(m.host, m.port);
        }
        catch {
            this.emit('monitorError', { message: 'Use a trusted loopback HeapLens agent address, and approve connection.' });
        }
    },
    async monitorHistogram() {
        try {
            const monitor = this.monitor;
            if (!monitor || monitor.closed)
                throw Error();
            if (await this.consent('Snapshot histogram', 'This request may pause the target JVM. Continue?', [['Request snapshot', 'snapshot'], ['Cancel', null]]) === 'snapshot' && monitor === this.monitor)
                monitor.histogram();
            else
                this.emit('monitorError', { message: 'Histogram request cancelled.' });
        }
        catch {
            this.emit('monitorError', { message: 'Connect the agent first.' });
        }
    }
};
module.exports.install = session => { for (const [name, action] of Object.entries(actions))
    session[name] = action.bind(session); for (const [command, handler] of Object.entries({ startMonitor: m => session.startMonitor(m), stopMonitor: m => { session.monitor?.close(); session.monitor = null; }, requestMonitorHistogram: m => session.monitorHistogram(m) }))
    session.commands.set(command, handler); };
