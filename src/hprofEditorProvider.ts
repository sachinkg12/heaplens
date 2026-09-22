import * as vscode from 'vscode';
import * as fs from 'fs';
import { RustClient } from './rustClient';
import { getWebviewContent } from './webviewProvider';
import { AnalysisData, formatAnalysisContext } from './analysisContext';
import { streamLlmResponse, LlmConfig, ChatMessage } from './llmClient';
import { HEAP_ANALYSIS_SYSTEM_PROMPT, buildAnalyzePrompt, sanitizeChatInput } from './promptTemplates';
import { resolveSource } from './sourceResolver';
import type { DependencyInfo } from './dependencyResolver';
import { allHandlers, MessageHandler, EditorState } from './messageHandlers';
import { monitorHandlers } from './monitorHandlers';
import { MonitorService } from './monitorService';
import { friendlyError } from './errorMessages';
import { executeAiFix } from './aiFixProvider';
import { trackEvent, classifyError } from './telemetry';
import { AnalysisSession } from './analysisSession';
import { deliverOrBufferWebviewMessage } from './webviewMessageDelivery';
import { LlmConfigurationService } from './llmConfigurationService';

/**
 * Custom readonly editor provider for .hprof files.
 *
 * When a user opens a .hprof file, this provider spawns the Rust server,
 * sends an analyze_heap request, and renders the tabbed analysis UI.
 */
export class HprofEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'heaplens.hprofEditor';

    private static readonly MAX_CHAT_HISTORY = 40; // 20 user + 20 assistant messages

    private static handlerMap = new Map<string, MessageHandler>(
        [...allHandlers, ...monitorHandlers].map(h => [h.command, h])
    );

    private outputChannel: vscode.OutputChannel;
    /** Per-editor state keyed by hprof file path. */
    private editors = new Map<string, EditorState>();
    /** Tracks the most recently focused editor's hprof path. */
    private activeHprofPath: string | null = null;
    /** Per-editor heartbeat intervals. */
    private heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>();
    /** Per-editor heartbeat failure counts. */
    private heartbeatFailures = new Map<string, number>();
    /** Per-editor analysis lifecycle, kept separate from editor rendering state. */
    private analysisSessions = new Map<string, AnalysisSession>();
    /** Active monitor service (one per extension, not per-editor). */
    private monitorService: MonitorService | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        outputChannel: vscode.OutputChannel,
        private readonly getServerPath: () => string,
        private readonly llmConfiguration: LlmConfigurationService
    ) {
        this.outputChannel = outputChannel;
    }

    private getChatStorageKey(hprofPath: string): string {
        return `heaplens.chat.${hprofPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    }

    private loadChatHistory(hprofPath: string): ChatMessage[] {
        const key = this.getChatStorageKey(hprofPath);
        return this.context.workspaceState.get<ChatMessage[]>(key, []);
    }

    private saveChatHistory(hprofPath: string, history: ChatMessage[]): void {
        const key = this.getChatStorageKey(hprofPath);
        this.context.workspaceState.update(key, history);
    }

    public async openCustomDocument(
        uri: vscode.Uri
    ): Promise<vscode.CustomDocument> {
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        return { uri, dispose: () => { /* no-op */ } };
    }

    public async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        };

        const hprofPath = document.uri.fsPath;
        this.activeHprofPath = hprofPath;

        this.outputChannel.show(true);
        this.outputChannel.appendLine(`[HeapLens] Opening HPROF file: ${hprofPath}`);
        this.outputChannel.appendLine(`[HeapLens] File exists: ${fs.existsSync(hprofPath)}`);

        webviewPanel.webview.html = getWebviewContent(webviewPanel.webview, this.context.extensionUri);

        // Create a per-editor Rust client (each editor gets its own server subprocess)
        const client = this.createClient(hprofPath);
        if (!client) {
            this.outputChannel.appendLine('[HeapLens] ERROR: Failed to create Rust client');
            webviewPanel.webview.postMessage({
                command: 'error',
                message: 'Failed to start analysis server'
            });
            return;
        }
        this.outputChannel.appendLine('[HeapLens] Per-editor Rust client created successfully');

        // Create per-editor state (restore chat from workspace storage)
        const savedChat = this.loadChatHistory(hprofPath);
        const editorState: EditorState = {
            webviewPanel,
            client,
            analysisData: null,
            chatHistory: savedChat,
            pendingWebviewMessage: null,
            webviewReady: false,
            dependencyInfoCache: new Map(),
            fixedClasses: new Set()
        };
        this.editors.set(hprofPath, editorState);

        // Clean up when the editor tab is closed
        webviewPanel.onDidDispose(() => {
            this.outputChannel.appendLine(`[HeapLens] Editor disposed for: ${hprofPath}`);
            this.analysisSessions.get(hprofPath)?.dispose();
            this.analysisSessions.delete(hprofPath);
            // Dispose the per-editor client (kills the subprocess)
            const state = this.editors.get(hprofPath);
            if (state?.client && !state.client.isDisposed) {
                state.client.dispose();
                this.outputChannel.appendLine(`[HeapLens] Per-editor client disposed for: ${hprofPath}`);
            }
            this.stopHeartbeat(hprofPath);
            this.editors.delete(hprofPath);
            if (this.activeHprofPath === hprofPath) {
                this.activeHprofPath = null;
            }
        });

        // Wire webview <-> RustClient message passing (handler registry)
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            this.outputChannel.appendLine(`[HeapLens] Webview message: ${message.command}`);
            const state = this.editors.get(hprofPath);
            if (!state) { return; } // editor was disposed
            const handler = HprofEditorProvider.handlerMap.get(message.command);
            if (handler) {
                await handler.handle(message, {
                    hprofPath,
                    state,
                    webviewPanel,
                    client,
                    outputChannel: this.outputChannel,
                    llmConfiguration: this.llmConfiguration,
                    provider: this
                });
            }
        });

        // Start analysis
        await this.analyzeFile(hprofPath, webviewPanel, client);
    }

    private createClient(hprofPath: string): RustClient | null {
        const serverPath = this.getServerPath();
        this.outputChannel.appendLine(`[HeapLens] Server binary path: ${serverPath}`);
        this.outputChannel.appendLine(`[HeapLens] Server binary exists: ${fs.existsSync(serverPath)}`);

        if (!fs.existsSync(serverPath)) {
            vscode.window.showErrorMessage(`HeapLens server not found at ${serverPath}. Build with: cd hprof-analyzer && cargo build --release`);
            return null;
        }

        try {
            const client = new RustClient(serverPath);
            client.onStderr = (msg: string) => {
                this.outputChannel.appendLine(`[server:${hprofPath}] ${msg.trim()}`);
            };
            client.onProcessExit = (code: number | null, signal: string | null) => {
                this.outputChannel.appendLine(`[HeapLens] Server process exited for ${hprofPath}: code=${code}, signal=${signal}`);
                this.analysisSessions.get(hprofPath)?.serverExited(
                    new Error(`Analysis server exited with code ${code}, signal ${signal}`)
                );
                // Notify only this editor's webview about the crash
                if ((code !== 0 && code !== null) || signal !== null) {
                    trackEvent('error/serverCrashed', {
                        exitCode: String(code),
                        signal: signal || 'none'
                    });
                    const state = this.editors.get(hprofPath);
                    if (state?.webviewReady) {
                        state.webviewPanel.webview.postMessage({ command: 'serverCrashed' });
                    }
                }
            };
            this.outputChannel.appendLine(`[HeapLens] Rust server process spawned for: ${hprofPath}`);
            this.startHeartbeat(hprofPath, client);
            return client;
        } catch (error: any) {
            this.outputChannel.appendLine(`[HeapLens] ERROR spawning server: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to start HeapLens server: ${error.message}`);
            return null;
        }
    }

    private async analyzeFile(
        hprofPath: string,
        webviewPanel: vscode.WebviewPanel,
        client: RustClient
    ): Promise<void> {
        const phaseMessages: Record<string, string> = {
            loading: 'Loading file...',
            graph_building: 'Building heap graph...',
            graph_built: 'Graph built, preparing...',
            dominators: 'Computing dominator tree...'
        };
        let lastPhase = 0;
        let progressRef: vscode.Progress<{ increment?: number; message?: string }> | null = null;

        this.outputChannel.appendLine(`[HeapLens] Sending analyze_heap request for: ${hprofPath}`);

        // Track file size for telemetry
        try {
            const stat = fs.statSync(hprofPath);
            trackEvent('analysis/started', {}, { fileSizeMB: Math.round(stat.size / (1024 * 1024)) });
        } catch { /* ignore stat errors */ }

        const analysisStartTime = Date.now();
        const configuredWarningMinutes = vscode.workspace
            .getConfiguration('heaplens')
            .get<number>('analysis.longRunningWarningMinutes', 5);
        const warningMinutes = Number.isFinite(configuredWarningMinutes)
            ? Math.max(0, configuredWarningMinutes)
            : 5;

        const session = new AnalysisSession(
            client,
            hprofPath,
            { longRunningWarningMs: warningMinutes * 60_000 },
            {
                onProgress: (params: any) => {
                    const state = this.editors.get(hprofPath);
                    this.outputChannel.appendLine(`[HeapLens] Progress: stage=${params.stage}, phase=${params.phase}/${params.total_phases}`);

                    const progressMsg: any = {
                        command: 'analysisProgress',
                        stage: params.stage,
                        phase: params.phase,
                        totalPhases: params.total_phases
                    };
                    if (params.summary) { progressMsg.summary = params.summary; }
                    if (params.file_metadata) { progressMsg.fileMetadata = params.file_metadata; }
                    if (state?.webviewReady) {
                        webviewPanel.webview.postMessage(progressMsg);
                    }

                    const phase = params.phase || 0;
                    const msg = phaseMessages[params.stage] || 'Analyzing...';
                    const increment = Math.max(0, (phase - lastPhase) * 25);
                    lastPhase = phase;
                    progressRef?.report({ increment, message: msg });
                },
                onLongRunning: async elapsedMs => {
                    const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60_000));
                    trackEvent('analysis/longRunning', {}, { elapsedMinutes });
                    this.outputChannel.appendLine(`[HeapLens] Analysis is still running after ${elapsedMinutes} minutes`);
                    const choice = await vscode.window.showWarningMessage(
                        `HeapLens analysis has been running for ${elapsedMinutes} minutes. Continue waiting or cancel it?`,
                        'Continue Waiting',
                        'Cancel Analysis'
                    );
                    return choice === 'Cancel Analysis' ? 'cancel' : 'continue';
                },
                onIgnoredNotification: (method, params) => {
                    this.outputChannel.appendLine(
                        `[HeapLens] Ignored stale ${method} notification for request ${params?.request_id}`
                    );
                },
                onCancellationError: error => {
                    this.outputChannel.appendLine(`[HeapLens] Cancellation request failed: ${error.message}`);
                    void vscode.window.showWarningMessage(
                        'HeapLens could not cancel the analysis. It will continue running.'
                    );
                }
            }
        );
        this.analysisSessions.set(hprofPath, session);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'HeapLens: Analyzing HPROF File',
                cancellable: true
            },
            async (progress, cancellationToken) => {
                progressRef = progress;
                progress.report({ message: 'Starting analysis...' });

                // Handle VS Code cancellation
                cancellationToken.onCancellationRequested(() => {
                    trackEvent('analysis/cancelled');
                    this.outputChannel.appendLine('[HeapLens] User requested analysis cancellation');
                    void session.cancel();
                });

                try {
                    this.outputChannel.appendLine('[HeapLens] Awaiting analyze_heap response...');
                    const outcome = await session.run();

                    if (outcome.status === 'completed') {
                        this.handleCompletedAnalysis(
                            hprofPath,
                            webviewPanel,
                            outcome.result,
                            analysisStartTime
                        );
                        this.outputChannel.appendLine(`[HeapLens] Analysis completed in ${Date.now() - analysisStartTime}ms`);
                        progress.report({ increment: 100, message: 'Done!' });
                    } else if (outcome.status === 'cancelled') {
                        this.outputChannel.appendLine('[HeapLens] Analysis cancelled');
                        const state = this.editors.get(hprofPath);
                        if (state) {
                            const delivery = deliverOrBufferWebviewMessage(
                                state,
                                { command: 'analysisCancelled' },
                                pending => webviewPanel.webview.postMessage(pending)
                            );
                            this.outputChannel.appendLine(
                                delivery === 'posted'
                                    ? '[HeapLens] Posted analysisCancelled to webview'
                                    : '[HeapLens] Webview not ready yet, buffering analysisCancelled'
                            );
                        }
                        progress.report({ message: 'Cancelled' });
                    }
                } catch (error: any) {
                    const errMsg = error.message || 'unknown';
                    trackEvent('analysis/failed', {
                        errorType: classifyError(errMsg),
                        errorSummary: errMsg.substring(0, 200).replace(/[/\\]/g, '_')
                    });
                    this.outputChannel.appendLine(`[HeapLens] ERROR: ${error.message}`);
                    vscode.window.showErrorMessage(`HeapLens: ${friendlyError(error.message)}`);
                } finally {
                    if (this.analysisSessions.get(hprofPath) === session) {
                        this.analysisSessions.delete(hprofPath);
                    }
                }
            }
        );
    }

    private handleCompletedAnalysis(
        hprofPath: string,
        webviewPanel: vscode.WebviewPanel,
        params: any,
        analysisStartTime: number
    ): void {
        const state = this.editors.get(hprofPath);
        const topObjCount = (params.top_objects || []).length;
        const histCount = (params.class_histogram || []).length;
        const suspectCount = (params.leak_suspects || []).length;
        this.outputChannel.appendLine(
            `[HeapLens] Data: ${topObjCount} objects, ${histCount} histogram entries, ${suspectCount} leak suspects`
        );

        trackEvent('analysis/completed', {}, {
            durationMs: Math.round(Date.now() - analysisStartTime),
            objectCount: params.summary?.total_instances || 0,
            classCount: params.summary?.total_classes || 0,
            leakSuspectCount: suspectCount,
            heapSizeMB: Math.round((params.summary?.total_heap_size || 0) / (1024 * 1024))
        });

        const analysisData: AnalysisData = {
            summary: params.summary || null,
            topObjects: params.top_objects || [],
            leakSuspects: params.leak_suspects || [],
            classHistogram: params.class_histogram || [],
            wasteAnalysis: params.waste_analysis || undefined
        };
        if (state) { state.analysisData = analysisData; }

        const webviewMessage = {
            command: 'analysisComplete',
            topObjects: params.top_objects || [],
            topLayers: params.top_layers || [],
            summary: params.summary || null,
            classHistogram: params.class_histogram || [],
            leakSuspects: params.leak_suspects || [],
            objectLeakSuspects: params.object_leak_suspects || [],
            wasteAnalysis: params.waste_analysis || null
        };

        if (state) {
            const delivery = deliverOrBufferWebviewMessage(
                state,
                webviewMessage,
                pending => webviewPanel.webview.postMessage(pending)
            );
            this.outputChannel.appendLine(
                delivery === 'posted'
                    ? '[HeapLens] Posted analysisComplete to webview'
                    : '[HeapLens] Webview not ready yet, buffering analysisComplete'
            );
        }
    }

    public async cancelAnalysis(hprofPath: string): Promise<void> {
        const session = this.analysisSessions.get(hprofPath);
        if (!session) {
            this.outputChannel.appendLine(`[HeapLens] No active analysis to cancel for: ${hprofPath}`);
            return;
        }
        await session.cancel();
    }

    public async retryAnalysis(hprofPath: string): Promise<void> {
        if (this.analysisSessions.has(hprofPath)) {
            this.outputChannel.appendLine(`[HeapLens] Analysis is already active for: ${hprofPath}`);
            return;
        }

        const state = this.editors.get(hprofPath);
        if (!state || state.client.isDisposed) {
            state?.webviewPanel.webview.postMessage({
                command: 'error',
                message: 'The analysis server is not available. Close and reopen the heap dump to restart it.'
            });
            return;
        }

        await this.analyzeFile(hprofPath, state.webviewPanel, state.client);
    }

    public async handleChatMessage(text: string, hprofPath: string, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const state = this.editors.get(hprofPath);
        if (!state) { return; }

        // Sanitize and validate input before sending to LLM
        const validation = sanitizeChatInput(text);
        if (!validation.safe) {
            webviewPanel.webview.postMessage({
                command: 'chatError',
                message: validation.reason
            });
            return;
        }
        text = validation.text;

        let llmConfig: LlmConfig;
        try {
            llmConfig = await this.llmConfiguration.getConfig();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`[HeapLens] Secure credential access failed: ${message}`);
            webviewPanel.webview.postMessage({
                command: 'chatError',
                message: 'Secure credential storage is unavailable. See the HeapLens output for details.'
            });
            return;
        }

        trackEvent('feature/chatMessage', { provider: llmConfig.provider });

        if (!llmConfig.apiKey && llmConfig.provider !== 'ollama') {
            webviewPanel.webview.postMessage({
                command: 'chatError',
                message: 'No API key configured. Run "HeapLens: Set LLM API Key" from the Command Palette.'
            });
            return;
        }

        // Build messages with analysis context
        const messages: ChatMessage[] = [
            { role: 'system', content: HEAP_ANALYSIS_SYSTEM_PROMPT }
        ];

        // Add analysis context on first message or if no history
        if (state.chatHistory.length === 0 && state.analysisData) {
            const context = formatAnalysisContext(state.analysisData);
            const userPrompt = buildAnalyzePrompt(context, text);
            messages.push({ role: 'user', content: userPrompt });
        } else {
            // Include prior conversation (capped to prevent unbounded growth)
            messages.push(...state.chatHistory);
            messages.push({ role: 'user', content: text });
        }

        // Track user message
        state.chatHistory.push({ role: 'user', content: text });

        // Trim chat history if it exceeds the limit
        if (state.chatHistory.length > HprofEditorProvider.MAX_CHAT_HISTORY) {
            state.chatHistory = state.chatHistory.slice(-HprofEditorProvider.MAX_CHAT_HISTORY);
        }

        let assistantResponse = '';

        streamLlmResponse(
            llmConfig,
            messages,
            (chunk) => {
                assistantResponse += chunk;
                webviewPanel.webview.postMessage({ command: 'chatChunk', text: chunk });
            },
            () => {
                state.chatHistory.push({ role: 'assistant', content: assistantResponse });
                this.saveChatHistory(hprofPath, state.chatHistory);
                webviewPanel.webview.postMessage({ command: 'chatDone' });
            },
            (error) => {
                this.outputChannel.appendLine(`[HeapLens] Chat error: ${error}`);
                webviewPanel.webview.postMessage({ command: 'chatError', message: error });
            }
        );
    }

    private fmtBytes(bytes: number): string {
        if (bytes === 0) { return '0 B'; }
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        const idx = Math.min(i, sizes.length - 1);
        return (bytes / Math.pow(k, idx)).toFixed(idx > 1 ? 2 : 0) + ' ' + sizes[idx];
    }

    public handleCopyReport(hprofPath: string, webviewPanel: vscode.WebviewPanel): void {
        const state = this.editors.get(hprofPath);
        if (!state?.analysisData) {
            vscode.window.showWarningMessage('No analysis data available for report.');
            return;
        }

        const data = state.analysisData;
        const lines: string[] = [];

        lines.push('# HeapLens Incident Report');
        lines.push('');
        lines.push(`**File:** ${hprofPath}`);
        lines.push(`**Generated:** ${new Date().toISOString()}`);
        lines.push('');

        // Heap Summary
        if (data.summary) {
            const s = data.summary;
            lines.push('## Heap Summary');
            lines.push('');
            lines.push(`- **Total Heap Size:** ${this.fmtBytes(s.total_heap_size)}`);
            lines.push(`- **Reachable Heap Size:** ${this.fmtBytes(s.reachable_heap_size || s.total_heap_size)}`);
            lines.push(`- **Objects:** ${s.total_instances.toLocaleString()}`);
            lines.push(`- **Classes:** ${s.total_classes.toLocaleString()}`);
            lines.push(`- **Arrays:** ${s.total_arrays.toLocaleString()}`);
            lines.push(`- **GC Roots:** ${s.total_gc_roots.toLocaleString()}`);
            lines.push('');
        }

        // Leak Suspects
        if (data.leakSuspects && data.leakSuspects.length > 0) {
            lines.push('## Leak Suspects');
            lines.push('');
            data.leakSuspects.forEach((s: any) => {
                const severity = s.retained_percentage > 30 ? 'HIGH' : 'MEDIUM';
                lines.push(`- **[${severity}] ${s.class_name}** — ${s.retained_percentage.toFixed(1)}% of heap (${this.fmtBytes(s.retained_size)})`);
                lines.push(`  ${s.description}`);
            });
            lines.push('');
        }

        // Top Retained Objects
        if (data.topObjects && data.topObjects.length > 0) {
            const topFiltered = data.topObjects
                .filter((o: any) => o.retained_size > 0 && o.node_type !== 'Class' && o.node_type !== 'SuperRoot')
                .slice(0, 10);
            if (topFiltered.length > 0) {
                lines.push('## Top Retained Objects');
                lines.push('');
                lines.push('| Object | Shallow | Retained |');
                lines.push('|--------|---------|----------|');
                topFiltered.forEach((o: any) => {
                    const name = o.field_name ? `${o.field_name} = ${o.class_name}` : o.class_name;
                    lines.push(`| ${name} | ${this.fmtBytes(o.shallow_size)} | ${this.fmtBytes(o.retained_size)} |`);
                });
                lines.push('');
            }
        }

        // Top 10 classes
        if (data.classHistogram && data.classHistogram.length > 0) {
            lines.push('## Top 10 Classes by Retained Size');
            lines.push('');
            lines.push('| Class | Instances | Shallow | Retained |');
            lines.push('|-------|-----------|---------|----------|');
            data.classHistogram.slice(0, 10).forEach((e: any) => {
                lines.push(`| ${e.class_name} | ${e.instance_count.toLocaleString()} | ${this.fmtBytes(e.shallow_size)} | ${this.fmtBytes(e.retained_size)} |`);
            });
            lines.push('');
        }

        // Waste Analysis
        if (data.wasteAnalysis && data.wasteAnalysis.total_wasted_bytes > 0) {
            const w = data.wasteAnalysis;
            lines.push('## Waste Analysis');
            lines.push('');
            lines.push(`- **Total Waste:** ${this.fmtBytes(w.total_wasted_bytes)} (${w.waste_percentage.toFixed(1)}% of heap)`);
            lines.push(`- **Duplicate Strings:** ${this.fmtBytes(w.duplicate_string_wasted_bytes)}`);
            lines.push(`- **Empty Collections:** ${this.fmtBytes(w.empty_collection_wasted_bytes)}`);

            if (w.duplicate_strings && w.duplicate_strings.length > 0) {
                lines.push('');
                lines.push('**Top Duplicate Strings:**');
                lines.push('');
                lines.push('| Preview | Copies | Wasted |');
                lines.push('|---------|--------|--------|');
                w.duplicate_strings.slice(0, 10).forEach((d: any) => {
                    const preview = (d.preview || '(empty)').substring(0, 60).replace(/\|/g, '\\|');
                    lines.push(`| ${preview} | ${d.count.toLocaleString()} | ${this.fmtBytes(d.wasted_bytes)} |`);
                });
            }

            if (w.empty_collections && w.empty_collections.length > 0) {
                lines.push('');
                lines.push('**Empty Collections:**');
                lines.push('');
                lines.push('| Class | Count | Wasted |');
                lines.push('|-------|-------|--------|');
                w.empty_collections.forEach((e: any) => {
                    lines.push(`| ${e.class_name} | ${e.count.toLocaleString()} | ${this.fmtBytes(e.wasted_bytes)} |`);
                });
            }
            lines.push('');
        }

        const report = lines.join('\n');
        vscode.env.clipboard.writeText(report).then(() => {
            webviewPanel.webview.postMessage({ command: 'reportCopied' });
            this.outputChannel.appendLine('[HeapLens] Incident report copied to clipboard');
        });
    }

    public async handleGoToSource(className: string, hprofPath: string, webviewPanel: vscode.WebviewPanel): Promise<void> {
        this.outputChannel.appendLine(`[HeapLens] Go to source requested for: ${className}`);
        const state = this.editors.get(hprofPath);
        try {
            const result = await resolveSource(className);
            if (result) {
                this.outputChannel.appendLine(`[HeapLens] Source found: tier=${result.tier}, uri=${result.uri.fsPath}`);
                trackEvent('feature/goToSource', { tier: result.tier });
                await vscode.window.showTextDocument(result.uri, { viewColumn: vscode.ViewColumn.Beside });

                // Cache and send dependency info to webview
                const info: { tier: string; dependency?: DependencyInfo } = { tier: result.tier };
                if (result.dependency) {
                    info.dependency = result.dependency;
                }
                state?.dependencyInfoCache.set(className, info);

                webviewPanel.webview.postMessage({
                    command: 'dependencyResolved',
                    className,
                    tier: result.tier,
                    dependency: result.dependency
                });
            } else {
                this.outputChannel.appendLine(`[HeapLens] No source found for: ${className}`);
                webviewPanel.webview.postMessage({ command: 'sourceNotFound', className });
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`[HeapLens] Go to source error for ${className}: ${error.message}`);
            webviewPanel.webview.postMessage({ command: 'sourceNotFound', className });
        }
    }

    public async handleFixWithAi(
        message: any,
        hprofPath: string,
        webviewPanel: vscode.WebviewPanel,
        llmConfig: LlmConfig
    ): Promise<void> {
        const state = this.editors.get(hprofPath);
        if (!state) { return; }

        const className = message.className;

        // Check if already fixed this session
        if (state.fixedClasses.has(className)) {
            webviewPanel.webview.postMessage({
                command: 'fixWithAiDone',
                className,
                status: 'already-fixed'
            });
            vscode.window.showInformationMessage(`HeapLens: ${className} was already fixed this session.`);
            return;
        }

        try {
            const result = await executeAiFix(
                llmConfig,
                {
                    className,
                    retainedSize: message.retainedSize || 0,
                    retainedPercentage: message.retainedPercentage || 0,
                    description: message.description || ''
                },
                state,
                this.outputChannel,
                webviewPanel
            );

            trackEvent('feature/fixWithAi', { status: result.status });
            switch (result.status) {
                case 'diff-opened':
                    webviewPanel.webview.postMessage({
                        command: 'fixWithAiDone',
                        className,
                        status: 'diff-opened'
                    });
                    break;
                case 'already-fixed':
                    webviewPanel.webview.postMessage({
                        command: 'fixWithAiDone',
                        className,
                        status: 'already-fixed'
                    });
                    vscode.window.showInformationMessage(`HeapLens: ${result.message}`);
                    break;
                case 'source-not-found':
                    webviewPanel.webview.postMessage({
                        command: 'fixWithAiError',
                        className,
                        message: result.message || 'Source not found'
                    });
                    break;
                case 'error':
                    webviewPanel.webview.postMessage({
                        command: 'fixWithAiError',
                        className,
                        message: result.message || 'Unknown error'
                    });
                    break;
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`[HeapLens] Fix with AI error: ${error.message}`);
            webviewPanel.webview.postMessage({
                command: 'fixWithAiError',
                className,
                message: error.message || String(error)
            });
        }
    }

    public clearChatHistory(hprofPath: string): void {
        const key = this.getChatStorageKey(hprofPath);
        this.context.workspaceState.update(key, undefined);
    }

    /** Compatibility shim: returns the active editor's client. */
    public getRustClient(): RustClient | null {
        if (this.activeHprofPath) {
            const state = this.editors.get(this.activeHprofPath);
            if (state?.client && !state.client.isDisposed) {
                return state.client;
            }
        }
        return null;
    }

    /** Get the client for a specific hprof file. */
    public getEditorClient(hprofPath: string): RustClient | null {
        const state = this.editors.get(hprofPath);
        return state?.client && !state.client.isDisposed ? state.client : null;
    }

    public getAnalysisData(): AnalysisData | null {
        const state = this.activeHprofPath ? this.editors.get(this.activeHprofPath) : undefined;
        if (!state?.analysisData) {
            return null;
        }

        // Enrich leak suspects with cached dependency info
        const enriched: AnalysisData = {
            ...state.analysisData,
            leakSuspects: state.analysisData.leakSuspects.map(s => {
                const cached = state.dependencyInfoCache.get(s.class_name);
                if (cached?.dependency) {
                    return { ...s, dependency: cached.dependency };
                }
                return s;
            })
        };
        return enriched;
    }

    public getActiveWebviewPanel(): vscode.WebviewPanel | null {
        const state = this.activeHprofPath ? this.editors.get(this.activeHprofPath) : undefined;
        return state?.webviewPanel ?? null;
    }

    public getCurrentHprofPath(): string | null {
        return this.activeHprofPath;
    }

    public getMonitorService(): MonitorService | null {
        return this.monitorService;
    }

    /**
     * Starts the monitor from a command palette invocation.
     * Sends a startMonitor message to the active webview so the handler picks it up.
     */
    public startMonitorFromCommand(host: string, port: number): void {
        const panel = this.getActiveWebviewPanel();
        if (!panel) {
            vscode.window.showWarningMessage('HeapLens: Open an HPROF file first to use the Monitor tab.');
            return;
        }
        // Simulate the webview sending a startMonitor message by dispatching it
        // through the handler system directly
        const state = this.activeHprofPath ? this.editors.get(this.activeHprofPath) : undefined;
        if (!state) { return; }
        const handler = HprofEditorProvider.handlerMap.get('startMonitor');
        if (handler) {
            handler.handle(
                { command: 'startMonitor', host, port },
                {
                    hprofPath: this.activeHprofPath!,
                    state,
                    webviewPanel: panel,
                    client: state.client,
                    outputChannel: this.outputChannel,
                    llmConfiguration: this.llmConfiguration,
                    provider: this
                }
            );
        }
    }

    public setMonitorService(service: MonitorService | null): void {
        // Dispose previous if replacing
        if (this.monitorService && this.monitorService !== service) {
            this.monitorService.dispose();
        }
        this.monitorService = service;
    }

    private startHeartbeat(hprofPath: string, client: RustClient): void {
        this.stopHeartbeat(hprofPath);
        this.heartbeatFailures.set(hprofPath, 0);
        const interval = setInterval(async () => {
            if (!client || client.isDisposed) {
                this.stopHeartbeat(hprofPath);
                return;
            }
            const ok = await client.ping(5000);
            if (ok) {
                this.heartbeatFailures.set(hprofPath, 0);
            } else {
                const failures = (this.heartbeatFailures.get(hprofPath) || 0) + 1;
                this.heartbeatFailures.set(hprofPath, failures);
                this.outputChannel.appendLine(`[HeapLens] Heartbeat failure #${failures} for ${hprofPath}`);
                if (failures === 3) {
                    trackEvent('error/heartbeatFailed', {}, { consecutiveFailures: failures });
                    this.outputChannel.appendLine(
                        `[HeapLens] Server is temporarily unresponsive for ${hprofPath}; ` +
                        'keeping the live analysis attached'
                    );
                }
            }
        }, 15000);
        this.heartbeatIntervals.set(hprofPath, interval);
    }

    private stopHeartbeat(hprofPath: string): void {
        const interval = this.heartbeatIntervals.get(hprofPath);
        if (interval) {
            clearInterval(interval);
            this.heartbeatIntervals.delete(hprofPath);
        }
        this.heartbeatFailures.delete(hprofPath);
    }

    public dispose(): void {
        // Dispose monitor service
        if (this.monitorService) {
            this.monitorService.dispose();
            this.monitorService = null;
        }
        for (const session of this.analysisSessions.values()) {
            session.dispose();
        }
        this.analysisSessions.clear();
        // Dispose all per-editor clients and heartbeats
        for (const [hprofPath, state] of this.editors) {
            this.stopHeartbeat(hprofPath);
            if (state.client && !state.client.isDisposed) {
                state.client.dispose();
            }
        }
        this.editors.clear();
    }
}
