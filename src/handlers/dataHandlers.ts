import * as vscode from 'vscode';
import { MessageHandler } from '../messageHandlers';
import { trackEvent, extractQueryKeyword } from '../telemetry';
import { evaluateAlerts } from '../diffAlerts';

export const executeQueryHandler: MessageHandler = {
    command: 'executeQuery',
    async handle(message, ctx) {
        trackEvent('feature/queryExecuted', { keyword: extractQueryKeyword(message.query || '') });
        ctx.outputChannel.appendLine(`[HeapLens] executeQuery: ${message.query}`);
        try {
            const rpcParams: any = {
                path: ctx.hprofPath,
                query: message.query
            };
            if (message.page) { rpcParams.page = message.page; }
            if (message.pageSize) { rpcParams.page_size = message.pageSize; }
            const queryResult = await ctx.client.sendRequest('execute_query', rpcParams);
            ctx.webviewPanel.webview.postMessage({
                command: 'queryResult',
                result: queryResult,
                query: message.query
            });
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] executeQuery error: ${error.message}`);
            ctx.webviewPanel.webview.postMessage({
                command: 'queryError',
                error: error.message || String(error),
                query: message.query
            });
        }
    }
};

export const compareHeapsHandler: MessageHandler = {
    command: 'compareHeaps',
    async handle(message, ctx) {
        trackEvent('feature/compareHeaps');
        try {
            const compareResult = await ctx.client.sendRequest('compare_heaps', {
                current_path: ctx.hprofPath,
                baseline_path: message.baselinePath
            });
            ctx.webviewPanel.webview.postMessage({
                command: 'compareResult',
                result: compareResult
            });
            evaluateAlerts(compareResult, ctx);
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] compareHeaps error: ${error.message}`);
            ctx.webviewPanel.webview.postMessage({
                command: 'compareError',
                error: error.message || String(error)
            });
        }
    }
};

export const listAnalyzedFilesHandler: MessageHandler = {
    command: 'listAnalyzedFiles',
    async handle(_message, ctx) {
        try {
            const files = await ctx.client.sendRequest('list_analyzed_files', {});
            const otherFiles = Array.isArray(files) ? files.filter((f: string) => f !== ctx.hprofPath) : [];
            ctx.webviewPanel.webview.postMessage({
                command: 'analyzedFiles',
                files: otherFiles
            });
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] listAnalyzedFiles error: ${error.message}`);
            ctx.webviewPanel.webview.postMessage({
                command: 'analyzedFiles',
                files: []
            });
        }
    }
};

export const listAllAnalyzedFilesHandler: MessageHandler = {
    command: 'listAllAnalyzedFiles',
    async handle(_message, ctx) {
        try {
            const files = await ctx.client.sendRequest('list_analyzed_files', {});
            ctx.webviewPanel.webview.postMessage({
                command: 'allAnalyzedFiles',
                files: Array.isArray(files) ? files : []
            });
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] listAllAnalyzedFiles error: ${error.message}`);
            ctx.webviewPanel.webview.postMessage({
                command: 'allAnalyzedFiles',
                files: []
            });
        }
    }
};

export const getTimelineDataHandler: MessageHandler = {
    command: 'getTimelineData',
    async handle(message, ctx) {
        ctx.outputChannel.appendLine(`[HeapLens] getTimelineData request for ${message.paths?.length || 0} files`);
        try {
            const result = await ctx.client.sendRequest('get_timeline_data', {
                paths: message.paths || [],
                top_n: message.topN || 10
            });
            ctx.webviewPanel.webview.postMessage({
                command: 'timelineDataResponse',
                result
            });
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] getTimelineData error: ${error.message}`);
            ctx.webviewPanel.webview.postMessage({
                command: 'timelineDataResponse',
                result: null
            });
        }
    }
};

export const goToSourceHandler: MessageHandler = {
    command: 'goToSource',
    async handle(message, ctx) {
        await ctx.provider.handleGoToSource(message.className, ctx.hprofPath, ctx.webviewPanel);
    }
};

export const queryDependencyInfoHandler: MessageHandler = {
    command: 'queryDependencyInfo',
    async handle(message, ctx) {
        const cached = ctx.state.dependencyInfoCache.get(message.className);
        if (cached) {
            ctx.webviewPanel.webview.postMessage({
                command: 'dependencyResolved',
                className: message.className,
                tier: cached.tier,
                dependency: cached.dependency
            });
        }
    }
};

export const copyReportHandler: MessageHandler = {
    command: 'copyReport',
    async handle(_message, ctx) {
        trackEvent('feature/export', { format: 'report' });
        ctx.provider.handleCopyReport(ctx.hprofPath, ctx.webviewPanel);
    }
};

export const tabViewedHandler: MessageHandler = {
    command: 'tabViewed',
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async handle(message, _ctx) {
        trackEvent('feature/tabViewed', { tab: message.tab || 'unknown' });
    }
};

export const readyHandler: MessageHandler = {
    command: 'ready',
    async handle(_message, ctx) {
        ctx.outputChannel.appendLine('[HeapLens] Webview ready');
        ctx.state.webviewReady = true;
        if (ctx.state.pendingWebviewMessage) {
            ctx.outputChannel.appendLine('[HeapLens] Resending buffered analysisComplete to webview');
            ctx.webviewPanel.webview.postMessage(ctx.state.pendingWebviewMessage);
            ctx.state.pendingWebviewMessage = null;
        }
        if (ctx.state.chatHistory.length > 0) {
            ctx.webviewPanel.webview.postMessage({
                command: 'restoreChatHistory',
                messages: ctx.state.chatHistory
            });
            ctx.outputChannel.appendLine(`[HeapLens] Restored ${ctx.state.chatHistory.length} chat messages`);
        }
    }
};

export const clearChatHistoryHandler: MessageHandler = {
    command: 'clearChatHistory',
    async handle(_message, ctx) {
        ctx.state.chatHistory = [];
        ctx.provider.clearChatHistory(ctx.hprofPath);
        ctx.outputChannel.appendLine('[HeapLens] Chat history cleared');
    }
};

export const cancelAnalysisHandler: MessageHandler = {
    command: 'cancelAnalysis',
    async handle(message, ctx) {
        ctx.outputChannel.appendLine('[HeapLens] Cancel analysis requested from webview');
        try {
            await ctx.client.sendRequest('cancel_analysis', { path: ctx.hprofPath });
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] cancel_analysis error: ${error.message}`);
        }
    }
};

export const retryAnalysisHandler: MessageHandler = {
    command: 'retryAnalysis',
    async handle(_message, ctx) {
        ctx.outputChannel.appendLine('[HeapLens] Retry analysis requested from webview');
        ctx.webviewPanel.webview.postMessage({ command: 'analysisRetrying' });
        try {
            const response = await ctx.client.sendRequest('analyze_heap', { path: ctx.hprofPath });
            if (response.status !== 'processing') {
                ctx.webviewPanel.webview.postMessage({
                    command: 'error',
                    message: 'Unexpected response: ' + JSON.stringify(response)
                });
            }
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] Retry error: ${error.message}`);
            ctx.webviewPanel.webview.postMessage({
                command: 'error',
                message: error.message || String(error)
            });
        }
    }
};

export const exportHistogramCsvHandler: MessageHandler = {
    command: 'exportHistogramCsv',
    async handle(message, ctx) {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('histogram.csv'),
            filters: { 'CSV': ['csv'] }
        });
        if (uri) {
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(uri, encoder.encode(message.csv));
            ctx.outputChannel.appendLine(`[HeapLens] Histogram CSV exported to: ${uri.fsPath}`);
        }
    }
};

export const exportCompareMarkdownHandler: MessageHandler = {
    command: 'exportCompareMarkdown',
    async handle(message, ctx) {
        trackEvent('feature/export', { format: 'compare-markdown' });
        await vscode.env.clipboard.writeText(message.markdown);
        ctx.webviewPanel.webview.postMessage({ command: 'compareReportCopied' });
        ctx.outputChannel.appendLine('[HeapLens] Compare diff report copied to clipboard');
    }
};

export const exportCompareCsvHandler: MessageHandler = {
    command: 'exportCompareCsv',
    async handle(message, ctx) {
        trackEvent('feature/export', { format: 'compare-csv' });
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('heap-diff.csv'),
            filters: { 'CSV': ['csv'] }
        });
        if (uri) {
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(uri, encoder.encode(message.csv));
            ctx.outputChannel.appendLine(`[HeapLens] Compare CSV exported to: ${uri.fsPath}`);
        }
    }
};

export const dataHandlers: MessageHandler[] = [
    executeQueryHandler,
    compareHeapsHandler,
    listAnalyzedFilesHandler,
    listAllAnalyzedFilesHandler,
    getTimelineDataHandler,
    goToSourceHandler,
    queryDependencyInfoHandler,
    copyReportHandler,
    tabViewedHandler,
    readyHandler,
    clearChatHistoryHandler,
    cancelAnalysisHandler,
    retryAnalysisHandler,
    exportHistogramCsvHandler,
    exportCompareMarkdownHandler,
    exportCompareCsvHandler,
];
