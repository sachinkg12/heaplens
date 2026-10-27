import * as vscode from 'vscode';
import * as fs from 'fs';
import { basename } from 'path';
import { RustClient } from './rustClient';
import { analysisStorageArguments, analysisStorageReport } from './analysisStorage';
import { readAnalysisStorage } from './vscodeAnalysisStorage';
import { getWebviewContent } from './webviewProvider';
import { AnalysisData } from './analysisContext';
import { LlmConfig, ChatMessage } from './llmClient';
import { sanitizeChatInput } from './promptTemplates';
import { completedDiagnosisHistory, diagnosisDestination, diagnosisHistoryKey } from './diagnosisConversation';
import { resolveSource } from './sourceResolver';
import type { DependencyInfo } from './dependencyResolver';
import { allHandlers, MessageHandler, EditorState } from './messageHandlers';
import { monitorHandlers } from './monitorHandlers';
import { MonitorService } from './monitorService';
import { friendlyError } from './errorMessages';
import { executeAiFix } from './aiFixProvider';
import { trackEvent, classifyError } from './telemetry';
import { AnalysisSession } from './analysisSession';
import { deliverOrBufferWebviewMessage, deliverOrBufferProgress, guardWebviewMessages } from './webviewMessageDelivery';
import { EditorServerConnection } from './editorServerConnection';
import { LlmConfigurationService } from './llmConfigurationService';
import { randomBytes, createHash } from 'crypto';
import { EvidenceLedger, exactObjectId, investigate, investigationSeed, INVESTIGATION_LIMITS } from './aiInvestigation';
import { readInvestigation } from './investigationEngine';
import { callLlmChat } from './llmClient';

/**
 * Custom readonly editor provider for .hprof files.
 *
 * When a user opens a .hprof file, this provider spawns the Rust server,
 * sends an analyze_heap request, and renders the tabbed analysis UI.
 */
export class HprofEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'heaplens.hprofEditor';

    private readonly aiChats = new Map<string, { controller: AbortController; analysis: AnalysisData; client: RustClient; channel:string; extra:Record<string,unknown> }>();
    private readonly aiConfigurationWatchers: vscode.Disposable[] = [];
    private readonly chatDestinations = new Map<string, string>();
    private readonly aiEvidence = new Map<string, { analysis: AnalysisData; client: RustClient; ledger: EvidenceLedger }>();
    private readonly aiGrants = new Map<string, string>();
    private readonly copilotRuns=new Map<string,Set<AbortController>>();
    private readonly copilotIdentities=new WeakMap<AnalysisData,string>();

    private static handlerMap = new Map<string, MessageHandler>(
        [...allHandlers, ...monitorHandlers].map(h => [h.command, h])
    );

    private outputChannel: vscode.OutputChannel;
    /** Per-editor state keyed by hprof file path. */
    private editors = new Map<string, EditorState>();
    /** Tracks the most recently focused editor's hprof path. */
    private activeHprofPath: string | null = null;
    /** Each connection owns only its server generation and heartbeat. */
    private serverConnections = new Map<string, EditorServerConnection<RustClient>>();
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
        const invalidate=()=>{for(const path of this.editors.keys())this.cancelAiChat(path);};
        const settings=vscode.workspace.onDidChangeConfiguration?.(event=>{if(event.affectsConfiguration('heaplens.llm'))invalidate();});
        const secrets=context.secrets?.onDidChange?.(event=>{if(event.key.startsWith('heaplens.llm.credential.'))invalidate();});
        if(settings)this.aiConfigurationWatchers.push(settings);if(secrets)this.aiConfigurationWatchers.push(secrets);
    }

    private getChatStorageKey(hprofPath: string): string {
        // Older lossy keys are left intact but not restored: they can collide across dumps.
        return diagnosisHistoryKey(hprofPath);
    }

    private loadChatHistory(hprofPath: string): ChatMessage[] {
        const key = this.getChatStorageKey(hprofPath);
        const saved = this.context.workspaceState.get<ChatMessage[] | { destination?: string; messages: ChatMessage[] }>(key, []);
        if (Array.isArray(saved)) { return completedDiagnosisHistory(saved); }
        if (saved && typeof saved.destination === 'string' && Array.isArray(saved.messages)) {
            this.chatDestinations.set(hprofPath, saved.destination);
            return completedDiagnosisHistory(saved.messages);
        }
        return [];
    }

    private saveChatHistory(hprofPath: string, history: ChatMessage[]): void {
        const key = this.getChatStorageKey(hprofPath);
        this.context.workspaceState.update(key, { destination: this.chatDestinations.get(hprofPath), messages: completedDiagnosisHistory(history) });
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
        const openedAt = Date.now();
        let initialAnalysisPending = true;
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        };

        const hprofPath = document.uri.fsPath;
        this.activeHprofPath = hprofPath;

        this.outputChannel.show(true);
        this.outputChannel.appendLine(`[HeapLens] Opening HPROF file: ${hprofPath}`);
        this.outputChannel.appendLine(`[HeapLens] File exists: ${fs.existsSync(hprofPath)}`);
        this.outputChannel.appendLine('[HeapLens] Editor startup: paint-before-analysis handshake');

        // Create a per-editor Rust client (each editor gets its own server subprocess)
        const client = this.createClient(hprofPath);
        if (!client) {
            this.outputChannel.appendLine('[HeapLens] ERROR: Failed to create Rust client');
            webviewPanel.webview.html = '<!DOCTYPE html><html><body><p role="alert">HeapLens could not start the analysis server. Check the HeapLens output, then close and reopen this editor to try again.</p></body></html>';
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
        webviewPanel.onDidChangeViewState?.(event=>{if(event.webviewPanel.active && this.editors.get(hprofPath)===editorState)this.activeHprofPath=hprofPath;});
        editorState.analysisMode = vscode.workspace.getConfiguration('heaplens').get<string>('analysis.initialMode', 'full') === 'shallow' ? 'shallow' : 'full';

        // Clean up when the editor tab is closed
        webviewPanel.onDidDispose(() => {
            if (this.editors.get(hprofPath) !== editorState) { return; }
            this.outputChannel.appendLine(`[HeapLens] Editor disposed for: ${hprofPath}`);
            this.cancelAiChat(hprofPath);
            this.analysisSessions.get(hprofPath)?.dispose();
            this.analysisSessions.delete(hprofPath);
            this.editors.delete(hprofPath);
            this.serverConnections.get(hprofPath)?.dispose();
            this.serverConnections.delete(hprofPath);
            if (this.activeHprofPath === hprofPath) {
                this.activeHprofPath = null;
            }
        });

        // Wire webview <-> RustClient message passing (handler registry)
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            this.outputChannel.appendLine(`[HeapLens] Webview message: ${message.command}`);
            const state = this.editors.get(hprofPath);
            if (state !== editorState) { return; } // editor was disposed/replaced
            const requestClient = state.client;
            if ((state.analysisMode === 'shallow' || this.analysisSessions.has(hprofPath)) && !['ready', 'tabViewed', 'quickScan', 'analyzeRetained', 'cancelAnalysis', 'retryAnalysis', 'exportHistogramCsv'].includes(message.command)) {
                webviewPanel.webview.postMessage({ command: 'analysisModeStatus', message: 'Choose Analyze Retained before using this action. No full analysis was started.' });
                return;
            }
            const currentPanel = guardWebviewMessages(webviewPanel, () =>
                this.editors.get(hprofPath) === state && state.client === requestClient
            );
            const handler = HprofEditorProvider.handlerMap.get(message.command);
            if (handler) {
                await handler.handle(message, {
                    hprofPath,
                    state,
                    webviewPanel: currentPanel,
                    client: requestClient,
                    outputChannel: this.outputChannel,
                    llmConfiguration: this.llmConfiguration,
                    provider: this
                });
            }
            if (message.command === 'ready' && initialAnalysisPending) {
                initialAnalysisPending = false;
                if (state.client !== client || client.isDisposed) { return; }
                this.outputChannel.appendLine(`[HeapLens] Webview initialized in ${Date.now() - openedAt}ms; starting analysis`);
                void this.analyzeFile(hprofPath, webviewPanel, client).catch(error => {
                    if (this.editors.get(hprofPath) !== editorState) { return; }
                    this.outputChannel.appendLine(`[HeapLens] Analysis startup failed: ${error}`);
                    deliverOrBufferWebviewMessage(editorState, {
                        command: 'analysisFailed', message: 'Analysis could not start. Retry is available.'
                    }, pending => webviewPanel.webview.postMessage(pending));
                });
            }
        });

        // Install the receiver before loading HTML. The first painted webview
        // starts the one analysis job; resolving the editor never awaits it.
        webviewPanel.webview.html = getWebviewContent(webviewPanel.webview, this.context.extensionUri);
    }

    private createClient(hprofPath: string): RustClient | null {
        try {
            let connection = this.serverConnections.get(hprofPath);
            if (!connection) {
                connection = new EditorServerConnection(() => {
                    const serverPath = this.getServerPath();
                    this.outputChannel.appendLine(`[HeapLens] Server binary path: ${serverPath}`);
                    if (!fs.existsSync(serverPath)) { throw new Error(`HeapLens server not found at ${serverPath}`); }
                    const storage = readAnalysisStorage();
                    this.outputChannel.appendLine(`[HeapLens] Reference storage: ${storage.mode}`);
                    const client = new RustClient(serverPath, analysisStorageArguments(storage));
                    this.outputChannel.appendLine(`[HeapLens] Rust server process spawned for: ${hprofPath} (pid: ${client.processId ?? 'unavailable'})`);
                    return client;
                }, {
                    onStderr: msg => this.outputChannel.appendLine(`[server:${hprofPath}] ${msg.trim()}`),
                    onUnavailable: (client, error, code, signal) => {
                        const state = this.editors.get(hprofPath);
                        if (state?.client !== client) { return; }
                        this.cancelAiChat(hprofPath);
                        this.outputChannel.appendLine(`[HeapLens] Server unavailable for ${hprofPath}: ${error.message}`);
                        this.analysisSessions.get(hprofPath)?.serverExited(error);
                        trackEvent('error/serverCrashed', {
                            exitCode: [0, 1, 2, 3, 4, 5, 6, 137, 139].includes(code as number) ? String(code) : 'unknown',
                            signal: !signal ? 'none' : ['SIGKILL', 'SIGTERM', 'SIGSEGV', 'SIGABRT', 'SIGBUS'].includes(signal) ? signal : 'other'
                        });
                        deliverOrBufferWebviewMessage(state, { command: 'serverCrashed' },
                            message => state.webviewPanel.webview.postMessage(message));
                    },
                    onHeartbeatFailure: failures => {
                        this.outputChannel.appendLine(`[HeapLens] Heartbeat failure #${failures} for ${hprofPath}`);
                        if (failures === 3) {
                            trackEvent('error/heartbeatFailed', {}, { consecutiveFailures: failures });
                            this.outputChannel.appendLine(`[HeapLens] Server temporarily unresponsive for ${hprofPath}; keeping the live analysis attached`);
                        }
                    }
                });
                this.serverConnections.set(hprofPath, connection);
            }
            return connection.connect();
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
        const owner = this.editors.get(hprofPath);
        const shallow = owner?.analysisMode === 'shallow';
        const operation = shallow ? 'scan_heap' : 'analyze_heap';
        if (owner) {
            deliverOrBufferWebviewMessage(owner, { command: 'analysisStarting', analysisScope: shallow ? 'shallow' : 'full' },
                message => webviewPanel.webview.postMessage(message));
        }
        const isCurrent = () => this.editors.get(hprofPath) === owner
            && owner?.client === client && this.serverConnections.get(hprofPath)?.isCurrent(client);
        const phaseMessages: Record<string, string> = {
            loading: 'Loading file...',
            graph_building: 'Building heap graph...',
            graph_built: 'Graph built, preparing...',
            dominators: 'Computing dominator tree...',
            sizing: 'Reading heap records...',
            catalog_building: 'Building object catalogs...',
            shallow_ready: 'Overview and shallow histogram ready; building references...',
            edges: 'Building references...',
            index_verifying: 'Verifying reusable index...',
            index_publishing: 'Validating and publishing index...',
            quick_scan: 'Scanning shallow allocations...'
        };
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
            { longRunningWarningMs: warningMinutes * 60_000, operation },
            {
                onProgress: (params: any) => {
                    if (!isCurrent()) { return; }
                    const state = this.editors.get(hprofPath);
                    const phase = Number.isSafeInteger(params.phase) && Number.isSafeInteger(params.total_phases)
                        ? `, phase=${params.phase}/${params.total_phases}` : '';
                    this.outputChannel.appendLine(`[HeapLens] Progress: stage=${params.stage}${phase}`);

                    const progressMsg: any = {
                        command: 'analysisProgress',
                        stage: params.stage,
                        phase: params.phase,
                        totalPhases: params.total_phases
                    };
                    if (params.summary) { progressMsg.summary = params.summary; }
                    if (params.file_metadata) { progressMsg.fileMetadata = params.file_metadata; }
                    if (params.snapshot) { progressMsg.snapshot = params.snapshot; }
                    if (state) { deliverOrBufferProgress(state, progressMsg, message => webviewPanel.webview.postMessage(message)); }

                    const msg = phaseMessages[params.stage] || 'Analyzing...';
                    // Stages are not equal work units: do not invent a percentage.
                    progressRef?.report({ message: `${msg} (${Math.floor((Date.now() - analysisStartTime) / 1000)}s elapsed)` });
                },
                onLongRunning: async elapsedMs => {
                    if (!isCurrent()) { return 'continue'; }
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
                    if (!isCurrent()) { return; }
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
                const cancellationSubscription = cancellationToken.onCancellationRequested(() => {
                    trackEvent('analysis/cancelled');
                    this.outputChannel.appendLine('[HeapLens] User requested analysis cancellation');
                    void session.cancel();
                });

                try {
                    this.outputChannel.appendLine('[HeapLens] Awaiting analyze_heap response...');
                    const outcome = await session.run();
                    if (!isCurrent()) { return; }

                    if (outcome.status === 'completed') {
                        if (shallow && owner) {
                            const result = outcome.result;
                            deliverOrBufferWebviewMessage(owner, {
                                command: 'shallowScanComplete', summary: result.summary,
                                classHistogram: result.class_histogram, readiness: result.readiness
                            }, message => webviewPanel.webview.postMessage(message));
                        } else { this.handleCompletedAnalysis(
                            hprofPath,
                            webviewPanel,
                            outcome.result,
                            analysisStartTime
                        ); }
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
                    if (!isCurrent()) { return; }
                    if (owner) {
                        deliverOrBufferWebviewMessage(owner, { command: 'analysisFailed', message: friendlyError(error.message) },
                            message => webviewPanel.webview.postMessage(message));
                    }
                    const errMsg = error.message || 'unknown';
                    trackEvent('analysis/failed', {
                        errorType: classifyError(errMsg)
                    });
                    this.outputChannel.appendLine(`[HeapLens] ERROR: ${error.message}`);
                    vscode.window.showErrorMessage(`HeapLens: ${friendlyError(error.message)}`);
                } finally {
                    cancellationSubscription.dispose();
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
        if (state) { state.analysisId = Number.isSafeInteger(params.request_id) && params.request_id > 0 ? String(params.request_id) : undefined; }

        const webviewMessage = {
            storage: analysisStorageReport(params.storage),
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

    public async retryAnalysis(hprofPath: string, mode?: 'full' | 'shallow'): Promise<void> {
        if (this.analysisSessions.has(hprofPath)) {
            this.outputChannel.appendLine(`[HeapLens] Analysis is already active for: ${hprofPath}`);
            return;
        }

        const state = this.editors.get(hprofPath);
        if (!state) { return; }
        state.analysisMode = mode ?? state.analysisMode ?? 'full';
        if (mode !== undefined) {
            // Mode changes retire the entire process generation, including old
            // object reads. Ordinary Cancel/Retry still reuses a live server.
            this.serverConnections.get(hprofPath)?.dispose();
            this.serverConnections.delete(hprofPath);
        }
        trackEvent('analysis/retry');
        // No await before ownership/session installation: repeated clicks cannot spawn twice.
        this.cancelAiChat(hprofPath);
        state.chatHistory = [];
        this.chatDestinations.delete(hprofPath);
        this.context.workspaceState.update(this.getChatStorageKey(hprofPath), undefined);
        state.analysisData = null;
        state.pendingWebviewMessage = null;
        deliverOrBufferWebviewMessage(state, { command: 'analysisRetrying' },
            message => state.webviewPanel.webview.postMessage(message));
        const client = this.createClient(hprofPath);
        if (!client) {
            deliverOrBufferWebviewMessage(state, {
                command: 'analysisFailed', message: 'Could not restart the analysis server. See HeapLens Output, then Retry.'
            }, message => state.webviewPanel.webview.postMessage(message));
            return;
        }
        state.client = client;
        await this.analyzeFile(hprofPath, state.webviewPanel, client);
    }

    public async handleChatMessage(text: string, hprofPath: string, webviewPanel: vscode.WebviewPanel): Promise<void> {
        await this.handleInvestigation(text,hprofPath,webviewPanel,{kind:'chat'});
    }

    public async handleExplain(message: any,kind: 'object' | 'leak',hprofPath: string,webviewPanel: vscode.WebviewPanel): Promise<void> {
        if(typeof message.className!=='string'||message.className.length>10000){return;}
        let selected: string | undefined;
        try { if(message.objectId !== undefined && message.objectId !== 0 && message.objectId !== '0')selected=exactObjectId(message.objectId); }
        catch {webviewPanel.webview.postMessage({command:kind==='object'?'explainError':'explainLeakError',objectId:message.objectId,className:message.className,message:'Object identity is not exact. Select it again.'});return;}
        const state=this.editors.get(hprofPath);
        const group=kind==='leak' && !selected ? state?.analysisData?.classHistogram.find(row=>row.class_name===message.className) : undefined;
        if(!selected && !group){webviewPanel.webview.postMessage({command:kind==='object'?'explainError':'explainLeakError',objectId:message.objectId,className:message.className,message:'Selection is no longer available.'});return;}
        const question=selected?'Explain the selected object '+selected+' using the actual retrieved evidence. Distinguish retention from a proven leak.'
            :'Explain the selected class group '+JSON.stringify(group?.class_name.slice(0,512))+'. This is not one object and not a proven leak.';
        await this.handleInvestigation(question,hprofPath,webviewPanel,{kind,objectId:selected,className:message.className,selected,group});
    }

    public stopAi(hprofPath: string): void { this.cancelAiChat(hprofPath); }

    public openAiEvidence(id: unknown,hprofPath: string,webviewPanel: vscode.WebviewPanel): void {
        const state=this.editors.get(hprofPath),entry=this.aiEvidence.get(hprofPath);
        try {
            if(!state || !entry || entry.analysis!==state.analysisData || entry.client!==state.client || state.client.isDisposed || typeof id!=='string')throw Error('Expired evidence');
            webviewPanel.webview.postMessage({command:'aiEvidenceResult',record:entry.ledger.get(id)});
        } catch {webviewPanel.webview.postMessage({command:'aiEvidenceResult',error:'Evidence expired or is not part of this analysis. Run the investigation again.'});}
    }

    private async handleInvestigation(text: string,hprofPath: string,webviewPanel: vscode.WebviewPanel,
        selection: {kind:'chat'|'object'|'leak';objectId?:unknown;className?:unknown;selected?:string;group?:unknown}): Promise<void> {
        const state = this.editors.get(hprofPath);
        if (!state) { return; }
        const channel=selection.kind==='chat'?'chat':selection.kind==='object'?'explain':'explainLeak';
        const extra={objectId:selection.objectId,className:selection.className};
        const report=(message:string)=>webviewPanel.webview.postMessage({command:channel+'Error',...extra,message});
        if (!state.analysisData || !state.analysisId || state.analysisMode === 'shallow' || state.client.isDisposed) {
            report('Complete retained analysis with the updated server before using AI investigation.');
            return;
        }
        if (this.aiChats.has(hprofPath)) {
            report('An AI action is active. Stop it or wait before starting another.');
            return;
        }

        // Sanitize and validate input before sending to LLM
        const validation = sanitizeChatInput(text);
        if (!validation.safe) {
            report(validation.reason || 'Invalid question.');
            return;
        }
        text = validation.text;

        const analysis = state.analysisData;
        const turn = { controller: new AbortController(), analysis, client: state.client, channel, extra };
        this.aiChats.set(hprofPath, turn);
        const active = () => this.editors.get(hprofPath) === state && this.aiChats.get(hprofPath) === turn
            && state.analysisData === analysis && state.client === turn.client && !turn.client.isDisposed && !turn.controller.signal.aborted;
        const fail = (message: string) => {
            if (!active()) { return; }
            this.aiChats.delete(hprofPath);
            report(message);
        };

        let llmConfig: LlmConfig;
        try {
            llmConfig = Object.freeze({ ...await this.llmConfiguration.getConfig() });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`[HeapLens] Secure credential access failed: ${message}`);
            fail('Secure credential storage is unavailable. See the HeapLens output for details.');
            return;
        }
        if (!active()) { return; }

        trackEvent('feature/chatMessage', { provider: llmConfig.provider });

        if (!llmConfig.apiKey && llmConfig.provider !== 'ollama') {
            fail('No API key configured. Run "HeapLens: Set LLM API Key" from the Command Palette.');
            return;
        }

        let destination: string;
        try { destination = diagnosisDestination(llmConfig); }
        catch { fail('AI endpoint or provider is invalid. Check the AI configuration.'); return; }
        if (this.chatDestinations.get(hprofPath) !== destination) {
            // Legacy history has no destination proof and must not be forwarded silently.
            state.chatHistory = [];
            this.chatDestinations.set(hprofPath, destination);
            this.aiEvidence.delete(hprofPath);this.aiGrants.delete(hprofPath);
        }
        const fingerprint=(config:LlmConfig)=>diagnosisDestination(config)+'|'+createHash('sha256').update(config.apiKey||'').digest('hex')+'|bounded-metadata-v1';
        const grant=fingerprint(llmConfig);
        let entry=this.aiEvidence.get(hprofPath);
        if(!entry || entry.analysis!==analysis || entry.client!==state.client){
            entry={analysis,client:state.client,ledger:new EvidenceLedger('S'+randomBytes(16).toString('hex'))};this.aiEvidence.set(hprofPath,entry);
        }
        const ledger=entry.ledger,analysisId=state.analysisId;
        const seed=investigationSeed(analysis.summary,analysis.topObjects,selection.group?[selection.group]:analysis.classHistogram);
        const sameConfiguration=async()=>{if(!active())return false;const latest=await this.llmConfiguration.getConfig();return active()&&fingerprint(latest)===grant;};
        // Restored text is display-only until it belongs to this live evidence generation.
        if(state.aiHistoryScope!==ledger.scope)state.chatHistory=[];
        try {
            const result=await investigate({scope:ledger.scope,destination,signal:turn.controller.signal,current:active,
                approve:async()=>{
                    if(this.aiGrants.get(hprofPath)===grant && await sameConfiguration())return true;
                    const decision=await vscode.window.showInformationMessage('Allow HeapLens AI investigation for this dump session?',{
                        modal:true,detail:'Destination: '+destination+'\nSends class/field names and types, exact object IDs, counts/sizes, reference and retaining-path metadata, plus your questions and completed chat history. These may be sensitive. Raw heap values, strings, source code and file paths are excluded. A local endpoint may forward remotely. Each question permits up to '+INVESTIGATION_LIMITS.modelCalls+' provider calls and '+INVESTIGATION_LIMITS.reads+' bounded engine reads; a provider may charge for each call. Stop/Clear/Retry/close or a configuration change revokes approval.'},'Approve this AI session');
                    if(decision!=='Approve this AI session'||!await sameConfiguration())return false;
                    this.aiGrants.set(hprofPath,grant);return true;
                },
                model:async(messages,signal,timeoutMs,tools)=>{
                    if(!await sameConfiguration()){this.aiGrants.delete(hprofPath);throw Error('AI configuration changed. Approve the new destination before sending.');}
                    return callLlmChat(llmConfig,messages,{signal,timeoutMs,tools});
                },
                read:(action,signal)=>readInvestigation(state.client,hprofPath,analysisId,action,signal),
                initialRead:selection.selected?{operation:'object',object_id:selection.selected}:undefined,
                progress:message=>{if(active())webviewPanel.webview.postMessage({command:'aiInvestigationProgress',channel,...extra,message});}
            },ledger,text,seed,selection.kind==='chat'?completedDiagnosisHistory(state.chatHistory):[]);
            if(!active())return;
            if(selection.kind==='chat' && !result.metadataOnly){
                state.chatHistory.push({role:'user',content:text},{role:'assistant',content:result.text});
                state.aiHistoryScope=ledger.scope;
                state.chatHistory=completedDiagnosisHistory(state.chatHistory);this.saveChatHistory(hprofPath,state.chatHistory);
            }
            webviewPanel.webview.postMessage({command:channel+'Chunk',...extra,text:result.text});
            webviewPanel.webview.postMessage({command:channel+'Done',...extra,safeEvidenceAnswer:true,metadataOnly:!!result.metadataOnly,evidence:result.evidence.map(e=>({id:e.id,operation:e.operation})),usage:{modelCalls:result.modelCalls,reads:result.reads}});
            this.aiChats.delete(hprofPath);
        } catch(error) {fail(error instanceof Error?error.message:'AI investigation failed. No automatic retry was made.');}
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
            lines.push(`- **Reachable Heap Size:** ${typeof s.reachable_heap_size === 'number' && Number.isFinite(s.reachable_heap_size) && s.reachable_heap_size >= 0 ? this.fmtBytes(s.reachable_heap_size) : 'Not calculated'}`);
            lines.push(`- **Objects:** ${s.total_instances.toLocaleString()}`);
            lines.push(`- **Classes:** ${s.total_classes.toLocaleString()}`);
            lines.push(`- **Arrays:** ${s.total_arrays.toLocaleString()}`);
            lines.push(`- **GC Roots:** ${s.total_gc_roots.toLocaleString()}`);
            if (s.size_model?.estimated) {
                lines.push(s.size_model.name === 'legacy-payload-v0'
                    ? '- **Size model:** Legacy payload-only estimate. Object headers and alignment are excluded.'
                    : '- **Size model:** JVM layout estimate, including object headers and alignment. Hidden VM fields and class metadata are excluded.');
            }
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
        if (!data.wasteAnalysis) {
            lines.push('## Waste Analysis', '', 'Not calculated. Use Calculate Waste in the Waste tab before including these results.', '');
        }
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
                case 'cancelled':
                case 'diff-opened':
                    webviewPanel.webview.postMessage({
                        command: 'fixWithAiDone',
                        className,
                        status: result.status
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
        this.cancelAiChat(hprofPath);
        const state = this.editors.get(hprofPath);
        if (state) { state.chatHistory = []; }
        this.chatDestinations.delete(hprofPath);
        const key = this.getChatStorageKey(hprofPath);
        this.context.workspaceState.update(key, undefined);
    }

    private cancelAiChat(hprofPath: string): void {
        const currentAnalysis=this.editors.get(hprofPath)?.analysisData;if(currentAnalysis)this.copilotIdentities.delete(currentAnalysis);
        this.copilotRuns.get(hprofPath)?.forEach(controller=>controller.abort());this.copilotRuns.delete(hprofPath);
        this.aiGrants.delete(hprofPath);
        this.aiEvidence.delete(hprofPath);
        const turn = this.aiChats.get(hprofPath);
        if (!turn) { return; }
        this.aiChats.delete(hprofPath);
        turn.controller.abort();
        this.editors.get(hprofPath)?.webviewPanel.webview.postMessage({ command: turn.channel+'Error', ...turn.extra, message: 'AI request cancelled because the conversation, configuration or analysis changed.' });
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

    public captureCopilotScope(): import('./copilotScope').CopilotAnalysisScope | null {
        const path=this.activeHprofPath,state=path?this.editors.get(path):undefined;
        if(!path || !state?.analysisData || !state.analysisId || state.client.isDisposed || state.analysisMode==='shallow')return null;
        const analysis=state.analysisData,client=state.client,analysisId=state.analysisId,controller=new AbortController();
        let identity=this.copilotIdentities.get(analysis);if(!identity){identity='C'+randomBytes(16).toString('hex');this.copilotIdentities.set(analysis,identity);}
        let runs=this.copilotRuns.get(path);if(!runs){runs=new Set();this.copilotRuns.set(path,runs);}runs.add(controller);
        const alive=()=>this.editors.get(path)===state && state.analysisData===analysis && state.client===client && !client.isDisposed && state.analysisId===analysisId && this.copilotIdentities.get(analysis)===identity;
        return {identity,label:basename(path),data:analysis,signal:controller.signal,current:alive,
            read:(action,signal)=>readInvestigation(client,path,analysisId,action,signal),
            dispose:()=>{runs?.delete(controller);if(!runs?.size && this.copilotRuns.get(path)===runs)this.copilotRuns.delete(path);}};
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

    public dispose(): void {
        this.copilotRuns.forEach(runs=>runs.forEach(controller=>controller.abort()));this.copilotRuns.clear();
        for(const watcher of this.aiConfigurationWatchers)watcher.dispose();
        for (const path of this.aiChats.keys()) { this.cancelAiChat(path); }
        this.aiGrants.clear();this.aiEvidence.clear();
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
        this.editors.clear();
        for (const connection of this.serverConnections.values()) { connection.dispose(); }
        this.serverConnections.clear();
    }
}
