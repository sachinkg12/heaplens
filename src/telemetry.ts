import * as vscode from 'vscode';
import { VSCodeTelemetry, TelemetryLevel } from './vscodeTelemetry';
let reporter: VSCodeTelemetry | null = null;
let shutdown = Promise.resolve();

export function initTelemetry(context: vscode.ExtensionContext): void {
    void disposeTelemetry();
    const permission = (): TelemetryLevel => {
        if (context.extensionMode !== vscode.ExtensionMode.Production || process.env.CI || process.env.DO_NOT_TRACK === '1') { return 'off'; }
        const host = vscode.env.isTelemetryEnabled ? vscode.workspace.getConfiguration('telemetry').get<string>('telemetryLevel', 'off') : 'off';
        const setting = vscode.workspace.getConfiguration('heaplens').inspect<string>('telemetry.level');
        const choice = setting?.globalValue ?? setting?.defaultValue ?? 'all';
        if (!['all', 'error', 'off', 'crash'].includes(host) || !['all', 'error', 'off'].includes(choice)) { return 'off'; }
        return host === 'off' || host === 'crash' || choice === 'off' ? 'off' : host === 'error' || choice === 'error' ? 'error' : 'all';
    };
    const current = new VSCodeTelemetry(context.extension.packageJSON.version, permission);
    reporter = current;
    const refresh = () => current.setLevel(permission());
    refresh();
    context.subscriptions.push(vscode.env.onDidChangeTelemetryEnabled(refresh),
        vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('heaplens.telemetry') || e.affectsConfiguration('telemetry')) { refresh(); } }),
        vscode.commands.registerCommand('heaplens.configureTelemetry', async () => {
            const choices = [
                { label: 'Off', description: 'Disable telemetry; send nothing', level: 'off' },
                { label: 'Errors only', description: 'Allowlisted failure codes and phase; no error text', level: 'error' },
                { label: 'Usage and errors', description: 'Default: filtered actions/timings plus VS Code machine/session counts', level: 'all' }
            ];
            const selected = await vscode.window.showQuickPick(choices, { title: 'HeapLens telemetry → Azure Application Insights',
                placeHolder: 'Usage includes Microsoft SDK machine/session identifiers. No dump/source/query text or raw errors. Off disables; Errors Only excludes usage/counting. Editor permission also applies.' });
            if (selected) { await vscode.workspace.getConfiguration('heaplens').update('telemetry.level', selected.level, vscode.ConfigurationTarget.Global); }
        }),
        vscode.commands.registerCommand('heaplens.reviewDiagnostics', async () => {
            const document = await vscode.workspace.openTextDocument({ content: JSON.stringify(reporter?.report() || {}, null, 2), language: 'json' });
            await vscode.window.showTextDocument(document);
        }), { dispose: () => reporter === current ? disposeTelemetry() : current.dispose() });
}

export function disposeTelemetry(): Promise<void> {
    const previous = reporter; reporter = null;
    if (previous) { shutdown = Promise.all([shutdown, previous.dispose()]).then(() => undefined); }
    return shutdown;
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
