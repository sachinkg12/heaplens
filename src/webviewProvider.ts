import * as vscode from 'vscode';
import { getStyles } from './webview/styles';
import { getHtmlTemplate } from './webview/template';
import { getRegistryJs } from './webview/js/registry';
import { getHelperJs } from './webview/js/helpers';
import { getOverviewJs } from './webview/js/overview';
import { getHistogramJs } from './webview/js/histogram';
import { getDominatorTreeJs } from './webview/js/dominatorTree';
import { getSourceJs } from './webview/js/source';
import { getChatJs } from './webview/js/chat';
import { getWasteJs } from './webview/js/waste';
import { getLeakSuspectsJs } from './webview/js/leakSuspects';
import { getGcPathJs } from './webview/js/gcPath';
import { getInspectorJs } from './webview/js/inspector';
import { getQueryJs } from './webview/js/query';
import { getCompareJs } from './webview/js/compare';
import { getFlamegraphJs } from './webview/js/flamegraph';
import { getTimelineJs } from './webview/js/timeline';
import { getProgressJs } from './webview/js/progress';
import { getMonitorJs } from './webview/js/monitor';
import { getProgressiveJs } from './webview/js/progressive';

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * Returns the HTML content for the HeapLens tabbed webview.
 *
 * Nine tabs:
 * 1. Overview — summary stats + top 10 objects table + treemap + bar chart
 * 2. Histogram — sortable class histogram table with search
 * 3. Dominator Tree — expandable tree with lazy drill-down
 * 4. Leak Suspects — card layout with severity indicators
 * 5. Waste — duplicate strings and empty collections analysis
 * 6. Source — browsable resolvable classes with source resolution status
 * 7. Query — HeapQL execution
 * 8. Compare — baseline comparison with delta charts
 * 9. AI Chat — LLM-powered heap analysis Q&A
 */
export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const d3Uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'd3.v7.min.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline';">
    <title>HeapLens</title>
    <style>
${getStyles()}
    </style>
</head>
<body>
${getHtmlTemplate()}

    <script nonce="${nonce}" src="${d3Uri}"></script>
    <script nonce="${nonce}">
    (function() {
        const vscode = acquireVsCodeApi();

        // Shared state: set once on analysisComplete, read by tabs that need re-render
        var analysisData = null;

${getRegistryJs()}
${getHelperJs()}
${getOverviewJs()}
${getHistogramJs()}
${getDominatorTreeJs()}
${getFlamegraphJs()}
${getSourceJs()}
${getChatJs()}
${getWasteJs()}
${getLeakSuspectsJs()}
${getGcPathJs()}
${getInspectorJs()}
${getQueryJs()}
${getCompareJs()}
${getTimelineJs()}
${getProgressJs()}
${getMonitorJs()}
${getProgressiveJs()}

        // Store analysisData for tabs that re-render on filter/sort/reset
        onMessage('analysisComplete', function(msg) {
            analysisData = msg;
        });

        vscode.postMessage({ command: 'ready' });
    })();
    </script>
</body>
</html>`;
}
