'use strict';
// Host adapter only: action schemas, budgets and evidence validation live in shared code.
const crypto = require('node:crypto');
const AI = require('./ai.cjs');
const { requestId } = require('./guards.cjs');
const { EvidenceLedger, exactObjectId, investigate, investigationSeed } = require('./build/aiInvestigation.js');
const { readInvestigation } = require('./build/investigationEngine.js');

async function run(session, message, kind) {
    const channel = kind === 'chat' ? 'ai' : kind === 'leak' ? 'explainLeak' : 'explain';
    const extra = { requestId: requestId(message), ...(kind !== 'chat' ? { objectId: message.objectId, className: message.className } : {}) };
    if (session.activeAi) { session.emit(channel + 'Error', { ...extra, message: 'Another AI action is active. Stop it first.' }); return; }
    const controller = new AbortController(); session.activeAi = controller;
    const stopWatching=session.watchAiView();
    const config = session.config, raw = session.raw, rpc = session.rpc, generation = session.generation, view = session.view;
    const current = () => !controller.signal.aborted && session.state === 'ready' && session.raw === raw && session.rpc === rpc
        && session.config === config && session.generation === generation && session.view === view;
    try {
        if (!config || !raw || !rpc || !current()) throw Error('Configure AI and finish retained analysis first.');
        let selected, group, question;
        if (kind === 'chat') {
            const input = session.host.prompts.sanitizeChatInput(message.text);
            if (!input.safe) throw Error(input.reason);
            question = input.text;
        } else {
            if (message.objectId !== undefined && message.objectId !== 0 && message.objectId !== '0') selected = exactObjectId(message.objectId);
            group = !selected && kind === 'leak' && raw.class_histogram.find(row => row.class_name === message.className);
            if (!selected && !group) throw Error('The selected object or class group is unavailable.');
            extra.objectId = selected;
            question = selected ? 'Explain selected object ' + selected + '; distinguish retention from a proven leak.'
                : 'Explain class group ' + JSON.stringify(group.class_name.slice(0, 512)) + '; this is not a single object or a proven leak.';
        }
        let entry = session.investigation;
        if (!entry || entry.config !== config || entry.raw !== raw || entry.rpc !== rpc || entry.generation !== generation) {
            entry = { config, raw, rpc, generation, ledger: new EvidenceLedger('S' + crypto.randomBytes(16).toString('hex')) };
            session.investigation = entry; session.history = []; session.chatGrant = null;
        }
        const ledger = entry.ledger;
        const engine = { sendRequest: (method, params, timeoutMs) => rpc.call(method, { ...params, path: session.file.path }, timeoutMs) };
        const result = await investigate({ scope: ledger.scope, destination: config.url.href, signal: controller.signal, current,
            initialRead: selected ? { operation: 'object', object_id: selected } : undefined,
            approve: async () => {
                if (session.chatGrant === config.scope) return current();
                const decision = await session.consent('Approve bounded AI investigation',
                    'Destination: ' + config.url.href + ' | ' + config.provider + ' | ' + config.model
                    + '\nSends class/field names and types, exact IDs/sizes/counts, bounded references/root paths and your questions/completed history. Names and typed text may be sensitive; this is not anonymization. Raw heap values, source and local paths are excluded. A local endpoint may forward remotely.'
                    + '\nEach question may use up to four provider calls and three read-only engine reads, with a 90-second overall deadline. Provider charges may apply. Stop cancels the current work; Clear, Configure, Retry and closing revoke this session approval.',
                    [['Approve session', 'send'], ['Cancel', null]], controller.signal);
                if (decision !== 'send' || !current()) return false;
                session.chatGrant = config.scope; return true;
            },
            model: (messages, signal, _timeout, tools) => { if (!current()) throw Error('Investigation changed.'); return AI.stream(config, messages, () => {}, signal, {chat:true,tools}); },
            read: (action, signal) => readInvestigation(engine, session.file.path, String(session.analysisId), action, signal),
            progress: text => session.emit('aiInvestigationProgress', { ...extra, channel: kind === 'chat' ? 'chat' : channel, message: text })
        }, ledger, question, investigationSeed(raw.summary, raw.top_objects || [], group ? [group] : raw.class_histogram || []), kind === 'chat' ? session.history : []);
        if (!current()) return;
        session.emit(channel + 'Chunk', { ...extra, text: result.text });
        session.emit(channel + 'Done', { ...extra, safeEvidenceAnswer: true, metadataOnly: !!result.metadataOnly, evidence: result.evidence.map(({ id, operation }) => ({ id, operation })),
            modelCalls: result.modelCalls, reads: result.reads });
        if (kind === 'chat' && !result.metadataOnly) {
            session.history.push({ role: 'user', content: question }, { role: 'assistant', content: result.text });
            while (session.history.length > 8 || session.history.reduce((n, x) => n + x.content.length, 0) > 24000) session.history.splice(0, 2);
        }
    } catch (error) {
        if (generation === session.generation && view === session.view) session.emit(channel + 'Error', { ...extra,
            message: config?.key ? String(error.message).split(config.key).join('[REDACTED]') : String(error.message) });
    } finally { stopWatching();if (session.activeAi === controller) session.activeAi = null; }
}
function evidence(session, id) {
    const entry = session.investigation;
    try {
        if (!entry || session.state !== 'ready' || entry.config !== session.config || entry.raw !== session.raw
            || entry.rpc !== session.rpc || entry.generation !== session.generation || typeof id !== 'string') throw Error();
        session.emit('aiEvidenceResult', { record: entry.ledger.get(id) });
    } catch { session.emit('aiEvidenceResult', { error: 'Evidence expired or is not part of this analysis. Run the investigation again.' }); }
}
module.exports = { run, evidence };
