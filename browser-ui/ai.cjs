'use strict';
const http = require('node:http'), https = require('node:https'), crypto = require('node:crypto');
const {ToolCallCollector,wireMessages,wireTools}=require('./build/aiToolProtocol.js');
function configuration(input, providers) {
    if (!Object.hasOwn(providers, input.provider))
        throw Error('Unknown provider');
    const p = providers[input.provider];
    const base = String(input.baseUrl || p.defaultBaseUrl).replace(/\/+$/, '');
    const url = new URL(base);
    if (base.length > 2048 || url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
        throw Error('Use HTTPS, or HTTP loopback, without URL credentials/query/fragment');
    const model = String(input.model || p.defaultModel);
    if (!/^[A-Za-z0-9_./:@+\-]{1,200}$/.test(model))
        throw Error('Invalid model ID');
    const key = String(input.key || '');
    if (key.length > 4096 || /[^\x21-\x7e]/.test(key) || !key && input.provider !== 'ollama')
        throw Error('Set a valid key for this provider');
    let chatPath = p.chatPath || (p.apiFormat === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
    if (base.endsWith('/v1') || base.endsWith('/v1beta/openai'))
        chatPath = chatPath.replace(/^\/v1\//, '/');
    return { provider: input.provider, model, key, url: new URL(base + chatPath), definition: p, scope: crypto.randomUUID() };
}
const pick = (row, fields) => Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k, row[k]]));
function suspectScope(id) {
    if (typeof id === 'number') return id === 0 ? 'class_group' : Number.isSafeInteger(id) && id > 0 ? 'object' : 'unknown';
    if (typeof id === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(id)) {
        const exact = BigInt(id);
        return exact === 0n ? 'class_group' : exact <= 18446744073709551615n ? 'object' : 'unknown';
    }
    return 'unknown';
}
function context(analysis) {
    return {
        summary: pick(analysis.summary || {}, ['total_heap_size', 'reachable_heap_size', 'total_instances', 'total_classes', 'total_arrays', 'total_gc_roots']),
        evidence_limits: 'Bounded metadata sample, not all objects or allocation history. Nested retained sizes and class totals overlap. Suspect percentages use reachable heap; class groups are not single objects. Missing evidence is not zero. Byte sizes may be JVM layout estimates.',
        top_objects: (analysis.top_objects || []).slice(0, 15).map(x => pick(x, ['object_id', 'class_name', 'node_type', 'shallow_size', 'retained_size'])),
        sample_counts: { top_objects: Math.min(15, (analysis.top_objects || []).length), supplied_top_objects: (analysis.top_objects || []).length,
            classes: Math.min(20, (analysis.class_histogram || []).length), supplied_classes: (analysis.class_histogram || []).length },
        classes: (analysis.class_histogram || []).slice(0, 20).map(x => pick(x, ['class_name', 'instance_count', 'shallow_size', 'retained_size'])),
        suspects: (analysis.leak_suspects || []).slice(0, 10).map(x => ({ ...pick(x, ['class_name', 'object_id', 'retained_size', 'retained_percentage']),
            scope: suspectScope(x.object_id) })),
        waste: analysis.waste_analysis ? pick(analysis.waste_analysis, ['total_wasted_bytes', 'duplicate_string_wasted_bytes', 'empty_collection_wasted_bytes']) : null,
        waste_status: analysis.waste_analysis ? 'ready' : 'not_calculated'
    };
}
function objectMetadata(fields) { return fields.map(x => ({ ...pick(x, ['name', 'field_type', 'ref_object_id']), ...(x.ref_summary ? { ref_summary: pick(x.ref_summary, ['class_name', 'retained_size']) } : {}) })); }
// Provider catalogue/protocols are shared at build time; network policy is a host adapter.
function stream(config, messages, onChunk, signal, options={}) {
    return new Promise((resolve, reject) => {
        const anthropic = config.definition.apiFormat === 'anthropic';
        const collector=new ToolCallCollector();
        const enabled=!!options.tools && config.definition.toolCalls===true
            && config.model===config.definition.defaultModel
            && config.url.origin===new URL(config.definition.defaultBaseUrl).origin;
        const body = Buffer.from(JSON.stringify(anthropic ?
            { model: config.model, stream: true, max_tokens: 4096, system: messages.filter(x => x.role === 'system').map(x => x.content).join('\n'), messages:wireMessages(messages,true),...wireTools(true,enabled) } :
            { model: config.model, stream: true, messages:wireMessages(messages,false),...wireTools(false,enabled) }));
        if (body.length > 512 * 1024)
            return reject(Error('AI request exceeds 512 KiB'));
        const headers = { 'Content-Type': 'application/json', 'Content-Length': body.length, ...config.definition.extraHeaders };
        if (config.key)
            headers[config.definition.authStyle === 'x-api-key' || anthropic ? 'x-api-key' : 'Authorization'] = config.definition.authStyle === 'x-api-key' || anthropic ? config.key : 'Bearer ' + config.key;
        let done = false, answer = '', buffer = '', held = '';
        let request;
        const timer = setTimeout(() => { request?.destroy(); finish(Error('AI request deadline exceeded')); }, 120000);
        function finish(error) { if (done)
            return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error)
            reject(error);
        else {
            if (held)
                onChunk(held);
            try{const toolCalls=collector.finish();if(options.chat&&toolCalls.length&&!enabled&&!messages.some(m=>m.tool_calls?.length))throw Error();resolve(options.chat?{text:answer+held,toolCalls}:answer+held);}catch{reject(Error('AI returned malformed or unoffered tool calls. No automatic retry was made.'));}
        } }
        function abort() { request?.destroy(); finish(Error('AI request cancelled')); }
        if (signal?.aborted)
            return abort();
        signal?.addEventListener('abort', abort, { once: true });
        request = (config.url.protocol === 'https:' ? https : http).request(config.url, { method: 'POST', headers }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                request.destroy();
                return finish(Error('Provider rejected the request. Check model, credentials, access and limits.'));
            } // No redirects/raw response bodies.
            // Keep IncomingMessage byte-oriented for Node network inspection.
            const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
            let total = 0, terminal = false;
            res.on('data', chunk => {
                if (done)
                    return;
                total += Buffer.byteLength(chunk);
                buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
                if (total > 2 * 1024 * 1024 || Buffer.byteLength(buffer) > 256 * 1024) {
                    request.destroy();
                    return finish(Error('AI response exceeds limits'));
                }
                let end;
                while ((end = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, end).trim();
                    buffer = buffer.slice(end + 1);
                    if (!line.startsWith('data:'))
                        continue;
                    const data = line.slice(5).trim();
                    if (data === '[DONE]') {
                        terminal = true;
                        continue;
                    }
                    try {
                        const event = JSON.parse(data);
                        collector.consume(event,anthropic);
                        if (event.error)
                            throw Error();
                        if (['length','content_filter'].includes(event.choices?.[0]?.finish_reason)
                            || ['max_tokens','refusal'].includes(event.delta?.stop_reason) || ['max_tokens','refusal'].includes(event.stop_reason)) throw Error();
                        if (event.type === 'message_stop' || event.choices?.[0]?.finish_reason)
                            terminal = true;
                        const text = anthropic ? event.delta?.text : event.choices?.[0]?.delta?.content;
                        if (typeof text === 'string') {
                            held += text;
                            if (config.key)
                                held = held.split(config.key).join('[REDACTED]');
                            const keep = config.key.length ? Math.min(config.key.length - 1, held.length) : 0;
                            const safe = held.slice(0, held.length - keep);
                            held = held.slice(held.length - keep);
                            answer += safe;
                            onChunk(safe);
                            if (answer.length + held.length > 64000)
                                throw Error();
                        }
                    }
                    catch {
                        request.destroy();
                        return finish(Error('Unsupported or malformed provider stream'));
                    }
                }
            });
            res.on('end', () => finish(terminal ? undefined : Error('Provider stream ended before completion')));
            res.on('error', () => finish(Error('AI connection interrupted')));
        });
        request.on('error', () => finish(Error('AI connection failed or cancelled')));
        request.end(body);
    });
}
module.exports = { configuration, context, objectMetadata, stream };
