import * as vscode from 'vscode';
// Host adapter only. The runtime contract and bounded delivery are shared with the browser.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Telemetry } = require('../telemetry/node.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { platform, architecture } = require('../telemetry/contract.cjs');
let reporter: { setLevel(level: string): void; track(name: string, properties?: Record<string,string>, measurements?: Record<string,number>): void; report(): unknown; dispose(): void } | null = null;

export function initTelemetry(context: vscode.ExtensionContext): void {
    disposeTelemetry();
    reporter = new Telemetry({ context: { host: 'vscode', version: context.extension.packageJSON.version,
        os: platform(process.platform), arch: architecture(process.arch) },
        disabled: context.extensionMode !== vscode.ExtensionMode.Production || !!process.env.CI || process.env.DO_NOT_TRACK === '1' });
    const refresh = () => {
        const host = vscode.env.isTelemetryEnabled ? vscode.workspace.getConfiguration('telemetry').get<string>('telemetryLevel', 'off') : 'off';
        const setting = vscode.workspace.getConfiguration('heaplens').inspect<string>('telemetry.level');
        const choice = setting?.globalValue ?? setting?.defaultValue ?? 'all';
        const level = host === 'off' || choice === 'off' ? 'off' : host === 'error' || choice === 'error' ? 'error' : host === 'all' && choice === 'all' ? 'all' : 'off';
        reporter?.setLevel(level);
    };
    refresh();
    context.subscriptions.push(vscode.env.onDidChangeTelemetryEnabled(refresh),
        vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('heaplens.telemetry') || e.affectsConfiguration('telemetry')) { refresh(); } }),
        vscode.commands.registerCommand('heaplens.configureTelemetry', async () => {
            const choices = [
                { label: 'Off', description: 'Disable telemetry; send nothing', level: 'off' },
                { label: 'Errors only', description: 'Allowlisted failure codes and phase; no error text', level: 'error' },
                { label: 'Usage and errors', description: 'Default: actions and rounded sizes/timings', level: 'all' }
            ];
            const selected = await vscode.window.showQuickPick(choices, { title: 'HeapLens telemetry → Azure Application Insights',
                placeHolder: 'Enabled by default. Choose Off to disable. No dump/source/query text, keys or stable IDs. Network services can process IP addresses. Editor permission also applies.' });
            if (selected) { await vscode.workspace.getConfiguration('heaplens').update('telemetry.level', selected.level, vscode.ConfigurationTarget.Global); }
        }),
        vscode.commands.registerCommand('heaplens.reviewDiagnostics', async () => {
            const document = await vscode.workspace.openTextDocument({ content: JSON.stringify(reporter?.report() || {}, null, 2), language: 'json' });
            await vscode.window.showTextDocument(document);
        }), { dispose: disposeTelemetry });
}

export function disposeTelemetry(): void {
    reporter?.dispose();
    reporter = null;
}

export function trackEvent(
    name: string,
    properties?: Record<string, string>,
    measurements?: Record<string, number>
): void {
    reporter?.track(name, properties, measurements);
}

// ---- Helpers ----

export function classifyError(msg: string): string {
    const lower = msg.toLowerCase();
    if (lower.includes('timeout') || lower.includes('timed out')) { return 'timeout'; }
    if (lower.includes('out of memory') || lower.includes('oom') || lower.includes('allocation failed')) { return 'memory_error'; }
    if (lower.includes('parse') || lower.includes('invalid') || lower.includes('corrupt') || lower.includes('unexpected') || lower.includes('malformed')) { return 'parse'; }
    if (lower.includes('not found') || lower.includes('enoent') || lower.includes('no such file')) { return 'not_found'; }
    if (lower.includes('permission') || lower.includes('eacces') || lower.includes('denied')) { return 'permission'; }
    if (lower.includes('spawn') || lower.includes('binary') || lower.includes('server')) { return 'server_spawn'; }
    if (lower.includes('cancel')) { return 'cancelled'; }
    if (lower.includes('killed') || lower.includes('signal')) { return 'killed'; }
    if (lower.includes('broken pipe') || lower.includes('epipe') || lower.includes('eof')) { return 'pipe_broken'; }
    return 'unknown';
}

export function extractQueryKeyword(query: string): string {
    const upper = query.trim().toUpperCase();
    const keywords = ['SELECT', 'GROUP BY', 'WHERE', 'ORDER BY', 'INSTANCES', 'RETAINED', 'COUNT'];
    for (const kw of keywords) {
        if (upper.startsWith(kw) || upper.includes(kw)) {
            return kw.toLowerCase().replace(' ', '_');
        }
    }
    return 'other';
}
