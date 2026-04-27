/**
 * Telemetry wrapper for HeapLens.
 *
 * Uses @vscode/extension-telemetry with Azure Application Insights.
 * Privacy: No PII, no file paths, no code content, no API keys.
 *
 * Open/Closed: This module exposes a single generic trackEvent() function.
 * Adding new events requires zero modifications here — just call trackEvent()
 * at the instrumentation site with any event name.
 */

import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';

let reporter: InstanceType<typeof TelemetryReporter> | null = null;

// ---- Lifecycle ----

export function initTelemetry(context: vscode.ExtensionContext): void {
    const connectionString: string | undefined = context.extension.packageJSON.telemetryConnectionString;
    if (!connectionString || connectionString === 'YOUR_CONNECTION_STRING_HERE') {
        return; // telemetry not configured — silently disabled
    }
    reporter = new TelemetryReporter(connectionString);
    context.subscriptions.push(reporter);
}

export function disposeTelemetry(): void {
    reporter?.dispose();
    reporter = null;
}

// ---- Core tracking function (stable — never needs modification) ----

export function trackEvent(
    name: string,
    properties?: Record<string, string>,
    measurements?: Record<string, number>
): void {
    reporter?.sendTelemetryEvent(name, properties, measurements);
}

// ---- Helpers ----

export function classifyError(msg: string): string {
    const lower = msg.toLowerCase();
    if (lower.includes('timeout') || lower.includes('timed out')) { return 'timeout'; }
    if (lower.includes('memory') || lower.includes('oom') || lower.includes('alloc')) { return 'oom'; }
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
