import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { HprofEditorProvider } from '../hprofEditorProvider';

/** Run with --extensionTestsPath in a real, isolated editor profile, not node --test. */
export async function run(): Promise<void> {
    const root = path.resolve(__dirname, '../..');
    const started = Date.now();
    const logs: Array<{ ms: number; line: string }> = [];
    const paints: any[] = [];
    const readChecks: Record<string, unknown> = {};
    const subscriptions: vscode.Disposable[] = [];
    const realDump = process.env.HEAPLENS_STARTUP_DUMP;
    let passed = false;
    let latestPanel: vscode.WebviewPanel | undefined;
    const channel = vscode.window.createOutputChannel('HeapLens startup regression');
    const output = new Proxy(channel, {
        get(target, property) {
            if (property === 'appendLine') { return (line: string) => {
                logs.push({ ms: Date.now() - started, line }); target.appendLine(line);
            }; }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
    const captured: { provider?: HprofEditorProvider } = {};
    const originalResolve = HprofEditorProvider.prototype.resolveCustomEditor;
    const failures: string[] = [];
    const probe = `
        vscode.postMessage({command:'startupProbe',stage:'firstPaint',visible:document.getElementById('stats-bar').getBoundingClientRect().width > 0,
            text:document.body.innerText});
        window.addEventListener('error', function(e) {
            vscode.postMessage({command:'startupProbeError', message:String(e.message)});
        });
        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (msg.command === 'startupProbeCancel') { document.getElementById('progress-cancel-btn').click(); return; }
            if (msg.command === 'startupProbeWaste') {
                document.getElementById('tabBtn-waste').click();
                var calculate = document.getElementById('calculate-waste-btn');
                if (!calculate || calculate.disabled) {
                    vscode.postMessage({command:'startupProbeError',message:'Waste action unavailable after completion'});
                } else calculate.click();
                return;
            }
            if (!['analysisStarting','analysisProgress','analysisComplete','analysisCancelled','wasteResult','wasteError'].includes(msg.command)) return;
            if (msg.snapshot && msg.snapshot.kind === 'shallow') document.getElementById('tabBtn-histogram').click();
            requestAnimationFrame(function() { requestAnimationFrame(function() {
                var stats = document.getElementById('stats-bar');
                vscode.postMessage({command:'startupProbe', stage:msg.stage || msg.command,
                    text:document.body.innerText.slice(0,4000), stats:stats.innerText,
                    histogram:document.getElementById('shallow-histogram').innerText.slice(0,10000),
                    rowCount:document.querySelectorAll('#shallow-histogram tbody tr').length,
                    queryEnabled:!document.getElementById('tabBtn-query').disabled,
                    elapsed:document.getElementById('analysis-elapsed').innerText,
                    waste:document.getElementById('waste-summary-bar').innerText,
                    status:document.getElementById('analysis-mode-status').innerText,
                    visible:stats.getBoundingClientRect().width > 0 || document.getElementById('tab-histogram').getBoundingClientRect().width > 0});
            }); });
        });
    `;
    const wrapPanel = (panel: vscode.WebviewPanel): vscode.WebviewPanel => {
        latestPanel = panel;
        subscriptions.push(panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'startupProbe') { paints.push({ ms: Date.now() - started, ...message }); }
            if (message.command === 'startupProbeError') { failures.push(message.message); }
        }));
        const webview = new Proxy(panel.webview, {
            get(target, property) {
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
            },
            set(target, property, value) {
                if (property === 'html') {
                    const ready = "vscode.postMessage({ command: 'ready' });";
                    assert.ok(value.includes(ready), 'Probe must use the production ready handshake');
                    value = value.replace(ready, probe + ready);
                }
                return Reflect.set(target, property, value);
            }
        });
        return new Proxy(panel, {
            get(target, property) {
                if (property === 'webview') { return webview; }
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
    };
    async function until(predicate: () => boolean, label: string): Promise<void> {
        const deadline = Date.now() + (realDump ? 300_000 : 20_000);
        while (!predicate() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); }
        assert.ok(predicate(), `${label}; logs=${JSON.stringify(logs)}; paints=${JSON.stringify(paints)}`);
    }
    try {
        // Use the contributed provider, real activation and actual editor lifecycle.
        // Only the subprocess is a deterministic fixture; no heap/AI data leaves this test.
        await vscode.workspace.getConfiguration('heaplens').update('telemetry.level', 'off', vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration('heaplens').update('analysis.storage', 'memory', vscode.ConfigurationTarget.Global);
        HprofEditorProvider.prototype.resolveCustomEditor = function(document, panel) {
            captured.provider = this;
            if (!realDump) { (this as any).getServerPath = () => path.join(root, 'scripts/test/startup-server.cjs'); }
            (this as any).outputChannel = output;
            return originalResolve.call(this, document, wrapPanel(panel));
        };
        const extension = vscode.extensions.getExtension('guptasachinn.heaplens');
        assert.ok(extension, 'Development extension must be discovered by the host');
        await extension.activate();
        const input = vscode.Uri.file(realDump || path.join(os.tmpdir(), `heaplens-startup-${process.pid}.hprof`));
        if (!realDump) { fs.writeFileSync(input.fsPath, Buffer.from('controlled-startup-fixture')); }
        await vscode.commands.executeCommand('vscode.openWith', input, HprofEditorProvider.viewType);
        await until(() => paints.some(p => p.stage === 'shallow_ready'), 'Shallow Histogram must paint while completion is withheld');
        assert.equal(paints.find(p => p.stage === 'firstPaint').visible, true);
        const early = paints.find(p => p.stage === 'shallow_ready');
        assert.equal(early.visible, true);
        if (!realDump) { assert.match(early.histogram, /startup\.Control/); }
        assert.ok(early.rowCount > 0);
        assert.match(early.stats, /Not calculated/);
        assert.equal(early.queryEnabled, false);
        assert.equal(logs.some(p => p.line.includes('Analysis completed in')), false);
        const firstPaint = paints.find(p => p.stage === 'firstPaint');
        const request = logs.find(p => p.line.includes('Sending analyze_heap request'));
        assert.ok(request);
        assert.ok(firstPaint.ms <= request.ms, 'Visible shell must precede the heavy request');
        const provider = captured.provider; assert.ok(provider);
        const client = provider.getRustClient(); assert.ok(client);
        if (!realDump) { await client.sendRequest('test_release'); }
        await until(() => paints.some(p => p.stage === 'analysisComplete'), 'Full results must paint after release');
        assert.equal(paints.find(p => p.stage === 'analysisComplete').queryEnabled, true);
        if (realDump) {
            const result = await client.sendRequest('execute_query', {
                path: input.fsPath,
                query: 'SELECT object_id, shallow_size, retained_size FROM instances LIMIT 1'
            });
            assert.equal(result.rows.length, 1);
            readChecks.queryRows = result.rows.length;
            assert.ok(latestPanel);
            const beforeWaste = Date.now();
            await latestPanel.webview.postMessage({ command: 'startupProbeWaste' });
            await until(() => paints.some(p => ['wasteResult', 'wasteError'].includes(p.stage)) || failures.length > 0,
                'The first Waste button request must finish');
            assert.deepEqual(failures, []);
            assert.equal(paints.some(p => p.stage === 'wasteError'), false);
            assert.doesNotMatch(paints.find(p => p.stage === 'wasteResult').waste, /Not calculated|Calculating/);
            const total = provider.getAnalysisData()?.wasteAnalysis?.total_wasted_bytes;
            assert.ok(typeof total === 'number' && Number.isFinite(total) && total >= 0);
            assert.equal(logs.filter(p => p.line.endsWith('Webview message: calculateWaste')).length, 1);
            readChecks.firstWasteMs = Date.now() - beforeWaste;
            readChecks.wasteBytes = total;
        }
        if (!realDump) {
            const beforeCancel = paints.length;
            const retry = provider.retryAnalysis(input.fsPath);
            await until(() => paints.slice(beforeCancel).some(p => p.stage === 'shallow_ready'), 'Retry must also stream before completion');
            assert.ok(latestPanel);
            await latestPanel.webview.postMessage({ command: 'startupProbeCancel' });
            await retry;
            await until(() => paints.slice(beforeCancel).some(p => p.stage === 'analysisCancelled'), 'Real Cancel button must cancel the job');
            assert.equal(paints.filter(p => p.stage === 'analysisCancelled').slice(-1)[0].queryEnabled, false);
        }
        assert.deepEqual(failures, []);
        assert.equal(logs.some(p => /undefined\/undefined/.test(p.line)), false);
        passed = true;
        console.log('HeapLens real-host startup regression passed', JSON.stringify({ host: vscode.env.appName,
            paints: paints.map(p => ({ ms: p.ms, stage: p.stage, visible: p.visible })) }));
    } finally {
        captured.provider?.dispose();
        HprofEditorProvider.prototype.resolveCustomEditor = originalResolve;
        for (const item of subscriptions) { item.dispose(); }
        channel.dispose();
        fs.writeFileSync(process.env.HEAPLENS_STARTUP_REPORT || path.join(os.tmpdir(), `heaplens-startup-${process.pid}.json`), JSON.stringify({
            status: passed ? 'passed' : 'failed', kind: realDump ? 'real-engine' : 'controlled-completion', input: realDump,
            host: vscode.env.appName, version: vscode.version, at: new Date().toISOString(), paints, logs, failures, readChecks
        }, null, 2));
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
}
