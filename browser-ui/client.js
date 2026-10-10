'use strict';
(() => {
    // Bearer capability stays in this closure; never in DOM, storage or API query strings.
    const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    history.replaceState(null, '', location.pathname);
    const view = crypto.randomUUID();
    let session = location.pathname.split('/').at(-1), cursor = 0, stopped = false, dialogBusy = false, activeConsent = null;
    const status = document.getElementById('browser-status'), dialog = document.getElementById('browser-dialog');
    let readyResolve;
    const readyAcknowledged = new Promise(resolve => { readyResolve = resolve; });
    async function api(url, body) {
        const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-HeapLens-Token': token, 'X-HeapLens-View': view, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit' });
        if (!response.ok)
            throw Error('Local service rejected the request. Use the launch URL again, or restart the CLI.');
        return response.json();
    }
    function send(message) {
        const request = api('/api/command', { session, message });
        if (message.command === 'ready')
            request.then(readyResolve, () => { });
        request.catch(error => { status.textContent = error.message; });
        return request;
    }
    window.heaplensSend = send;
    document.getElementById('browser-telemetry').onclick=async()=>{
        const selected=await choice('Telemetry','Telemetry is enabled by default (usage and errors). Disable it here for this running host, or launch with --telemetry off to keep it disabled from startup. Filtered records go to HeapLens Azure Application Insights. No paths, source/query/dump text, keys or stable IDs. Network services may process IP addresses. Disabling clears pending delivery.',[['Disable telemetry','off'],['Review local diagnostics','review'],['Cancel',null]]);
        if(selected)send({command:selected==='off'?'telemetryOff':'reviewDiagnostics'});
    };
    // The shared registry is a window-message adapter. Ignore other windows/frames.
    window.addEventListener('message', event => { if (event.source !== window || event.origin !== location.origin)
        event.stopImmediatePropagation(); }, true);
    function download(text, name, type = 'text/plain') { const blob = new Blob([text], { type }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    function node(tag, text) { const element = document.createElement(tag); if (text !== undefined)
        element.textContent = text; return element; }
    async function choice(title, text, options) {
        if (dialogBusy)
            return null;
        dialogBusy = true;
        dialog.replaceChildren(node('h2', title), node('p', text));
        const actions = node('div');
        actions.className = 'actions';
        dialog.append(actions);
        return new Promise(resolve => {
            let finished = false;
            function finish(value) { if (finished)
                return; finished = true; dialog.close(); dialogBusy = false; dialog.oncancel = null; resolve(value); }
            options.forEach(([label, value]) => { const button = node('button', label); button.className = 'btn'; button.onclick = () => finish(value); actions.append(button); });
            dialog.oncancel = event => { event.preventDefault(); finish(null); };
            dialog.showModal();
        });
    }
    function viewer(message) {
        if (dialogBusy)
            return;
        dialogBusy = true;
        dialog.replaceChildren(node('h2', message.label || 'Source'), node('p', message.description || 'Local source only. No automatic writes.'));
        const content = node('div');
        if (message.proposed !== undefined) {
            content.className = 'diff';
            for (const text of [message.original, message.proposed]) {
                const area = node('textarea');
                area.value = text;
                area.readOnly = true;
                content.append(area);
            }
        }
        else
            content.append(node('pre', message.text));
        dialog.append(content);
        const actions = node('div');
        actions.className = 'actions';
        dialog.append(actions);
        if (message.proposed !== undefined) {
            const exportButton = node('button', 'Download proposed .java');
            exportButton.className = 'btn';
            exportButton.onclick = () => download(message.proposed, 'HeapLens-proposed.java');
            actions.append(exportButton);
        }
        const close = node('button', 'Close');
        close.className = 'btn';
        actions.append(close);
        close.onclick = () => { dialog.close(); dialogBusy = false; };
        dialog.oncancel = () => { dialogBusy = false; };
        dialog.showModal();
    }
    async function configure(message) {
        if (dialogBusy) {
            send({ command: 'aiConfigurationCancelled' });
            return;
        }
        dialogBusy = true;
        dialog.replaceChildren(node('h2', 'Configure AI'), node('p', 'Keys stay in memory until Stop CLI. They are not saved, synced or included in exports. A local endpoint can forward remotely.'));
        const form = node('form');
        form.onsubmit = event => event.preventDefault();
        dialog.append(form);
        const fields = {};
        for (const [key, label] of [['provider', 'Provider'], ['model', 'Model ID (editable)'], ['baseUrl', 'Base URL (HTTPS or HTTP loopback)'], ['key', 'API key']]) {
            const wrap = node('label', label), input = node(key === 'provider' ? 'select' : 'input');
            fields[key] = input;
            if (key === 'provider')
                message.providers.forEach(p => { const option = node('option', p.name); option.value = p.id; input.append(option); });
            else {
                input.type = key === 'key' ? 'password' : 'text';
                input.autocomplete = 'off';
            }
            wrap.append(input);
            form.append(wrap);
        }
        function defaults() { const p = message.providers.find(p => p.id === fields.provider.value); fields.model.value = p.defaultModel; fields.baseUrl.value = p.defaultBaseUrl; fields.key.value = ''; }
        fields.provider.onchange = defaults;
        defaults();
        if (message.current) {
            for (const k of ['provider', 'model', 'baseUrl'])
                fields[k].value = message.current[k] || '';
        }
        const eye = node('button', 'Show/hide entered key');
        eye.type = 'button';
        eye.onclick = () => { fields.key.type = fields.key.type === 'password' ? 'text' : 'password'; };
        form.append(eye);
        function finish() { fields.key.value = ''; dialog.close(); dialogBusy = false; dialog.oncancel = null; }
        const actions = node('div');
        actions.className = 'actions';
        form.append(actions);
        for (const [label, accept] of [['Save for this session', true], ['Cancel', false]]) {
            const button = node('button', label);
            button.type = 'button';
            button.className = 'btn';
            button.onclick = () => { if (accept)
                send({ command: 'aiSetConfiguration', configuration: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value])) });
            else
                send({ command: 'aiConfigurationCancelled' }); finish(); };
            actions.append(button);
        }
        dialog.oncancel = () => { send({ command: 'aiConfigurationCancelled' }); finish(); };
        dialog.showModal();
    }
    async function event(message) {
        if(message.command==='diagnosticReport'){viewer({label:'Local filtered diagnostics',description:'Recent allowlisted records, reviewed locally. Opening this report does not upload it.',text:message.text});return;}
        if (message.command === 'browserStatus')
            status.textContent = message.message;
        else if (message.sizeModelsDiffer)
            status.textContent = 'Warning: producer size estimates differ. Deltas may reflect layout changes, not application growth.';
        else if (message.command === 'browserConsent') {
            activeConsent = message.id;
            choice(message.title, message.message, message.choices).then(answer => { if (activeConsent === message.id) {
                activeConsent = null;
                send({ command: 'browserConsentDecision', id: message.id, decision: answer });
            } });
            return;
        }
        else if (message.command === 'browserConsentClosed') {
            if (activeConsent === message.id) {
                activeConsent = null;
                dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
            }
            return;
        }
        else if (message.command === 'browserConfigure') {
            await configure(message);
            return;
        }
        else if (message.command === 'browserSource' || message.command === 'browserDiff') {
            viewer(message);
            return;
        }
        else if (message.command === 'browserDownload') {
            download(message.text, message.name, message.mime);
            return;
        }
        else if (message.command === 'browserCopy') {
            try {
                await navigator.clipboard.writeText(message.text);
                status.textContent = 'Incident report copied.';
            }
            catch {
                download(message.text, 'HeapLens-incident-report.md', 'text/markdown');
                status.textContent = 'Clipboard unavailable; downloaded report instead.';
            }
            return;
        }
        else if (message.command === 'browserStopped') {
            stopped = true;
            status.textContent = 'CLI stopped. Close this page.';
            return;
        }
        window.postMessage(message, location.origin);
    }
    const select = document.getElementById('browser-dump');
    select.onchange = () => { location.href = '/dump/' + select.value + '#token=' + encodeURIComponent(token); };
    for (const [id, command] of [['browser-retry', 'retryAnalysis'], ['browser-cancel', 'cancelAnalysis'], ['browser-history', 'exportChat'], ['browser-close', 'closeDump'], ['browser-stop', 'shutdown']])
        document.getElementById(id).onclick = async () => {
            if (['closeDump', 'shutdown'].includes(command) && await choice('Confirm', command === 'shutdown' ? 'Stop all analysis servers and erase in-memory AI keys/history?' : 'Close this dump and release its analysis server?', [['Confirm', true], ['Cancel', false]]) !== true)
                return;
        await send({ command });
        if (command === 'shutdown') {
            stopped = true;
            status.textContent = 'CLI stopped. Close this page.';
        }
        };
    async function poll() {
        while (!stopped) {
            try {
                const response = await api('/api/events?session=' + encodeURIComponent(session) + '&after=' + cursor);
                if (response.reset) {
                    status.textContent = 'Refreshing current state.';
                    cursor = response.cursor;
                    send({ command: 'ready' });
                }
                else
                    for (const entry of response.events) {
                        cursor = entry.seq;
                        await event(entry.message);
                    }
            }
            catch (error) {
                if (stopped)
                    break;
                status.textContent = error.message;
                stopped = true;
            }
            if (!stopped)
                await new Promise(resolve => setTimeout(resolve, 400));
        }
    }
    api('/api/catalog').then(async (data) => { data.dumps.forEach(d => { const option = node('option', d.label); option.value = d.id; option.selected = d.id === session; select.append(option); }); await readyAcknowledged; poll(); }).catch(error => { status.textContent = error.message; });
})();
