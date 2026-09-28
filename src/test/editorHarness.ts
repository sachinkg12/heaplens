import * as path from 'path';
import type { RustClient } from '../rustClient';
import type { HprofEditorProvider } from '../hprofEditorProvider';

/** Loads the real provider/handlers against a minimal editor host, without telemetry. */
export function editorHarness(clientFactory: () => unknown) {
    // CommonJS interception is scoped to synchronous module loading and restored immediately.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const modules = require('module') as any;
    const originalLoad = modules._load;
    const logs: string[] = [];
    const errors: string[] = [];
    const cancellations: Array<() => void> = [];
    const vscode = {
        Uri: { joinPath: () => ({ fsPath: '/media' }) },
        ProgressLocation: { Notification: 15 },
        workspace: { getConfiguration: () => ({ get: () => 0 }) },
        window: {
            showErrorMessage: (message: string) => { errors.push(message); },
            showWarningMessage: async () => 'Continue Waiting',
            withProgress: (_options: unknown, action: any) => action(
                { report: () => undefined },
                { onCancellationRequested: (callback: () => void) => {
                    cancellations.push(callback);
                    return { dispose: () => undefined };
                } }
            )
        }
    };
    const providerPath = require.resolve('../hprofEditorProvider');
    const dataPath = require.resolve('../handlers/dataHandlers');
    const treePath = require.resolve('../handlers/treeHandlers');
    for (const file of [providerPath, dataPath, treePath]) { delete require.cache[file]; }
    modules._load = function(request: string, parent: any, isMain: boolean) {
        if (request === 'vscode') { return vscode; }
        if (request.endsWith('/telemetry')) {
            return { trackEvent: () => undefined, classifyError: () => 'test', extractQueryKeyword: () => 'SELECT' };
        }
        if (parent?.filename === providerPath) {
            switch (request) {
                case './rustClient': return { RustClient: function() { return clientFactory(); } };
                case './webviewProvider': return { getWebviewContent: () => '<html></html>' };
                case './messageHandlers': return { allHandlers: [
                    ...originalLoad(dataPath, parent, false).dataHandlers,
                    ...originalLoad(treePath, parent, false).treeHandlers
                ] };
                case './monitorHandlers': return { monitorHandlers: [] };
                case './monitorService': return {};
                case './aiFixProvider': return {};
                case './sourceResolver': return {};
            }
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    let Provider: typeof HprofEditorProvider | undefined;
    try {
        Provider = originalLoad(providerPath, module, false).HprofEditorProvider;
    } finally {
        modules._load = originalLoad;
    }
    if (!Provider) { throw new Error('Provider did not load'); }
    const provider = new Provider(
        { extensionUri: {}, workspaceState: { get: () => [], update: () => undefined } } as any,
        { show: () => undefined, appendLine: (line: string) => logs.push(line) } as any,
        () => process.execPath, // An existing file; the factory determines the actual test client.
        {} as any
    );
    function panel() {
        const messages: any[] = [];
        let receive: (message: any) => Promise<void> = async () => undefined;
        let close = () => undefined;
        const value = {
            webview: {
                options: {}, html: '',
                postMessage: (message: any) => { messages.push(message); return Promise.resolve(true); },
                onDidReceiveMessage: (callback: typeof receive) => { receive = callback; }
            },
            onDidDispose: (callback: typeof close) => { close = callback; }
        };
        return { value, messages, send: (message: any) => receive(message), close: () => close() };
    }
    return {
        provider, panel, logs, errors, cancellations,
        open: (file: string, view: ReturnType<typeof panel>) => provider.resolveCustomEditor(
            { uri: { fsPath: path.resolve(file) }, dispose: () => undefined } as any, view.value as any
        )
    };
}

export class FakeServer {
    public isDisposed = false;
    public onProcessExit?: RustClient['onProcessExit'];
    public onProcessError?: (error: Error) => void;
    public onStderr?: RustClient['onStderr'];
    public requests: Array<{ method: string; params: any }> = [];
    public handlers = new Map<string, (params: any) => void>();
    public autoComplete = true;
    private requestId = 0;

    public async sendRequest(method: string, params?: any): Promise<any> {
        if (this.isDisposed) { throw new Error('Client is shutdown'); }
        this.requests.push({ method, params });
        if (method === 'analyze_heap') {
            const id = ++this.requestId;
            if (this.autoComplete) { queueMicrotask(() => this.complete(id)); }
            return { status: 'processing', request_id: id };
        }
        if (method === 'cancel_analysis') {
            queueMicrotask(() => this.handlers.get('heap_analysis_complete')?.({
                request_id: params.analysis_request_id, status: 'cancelled'
            }));
            return { cancelled: true };
        }
        return { rows: [{ object_id: 512 }], client: this };
    }
    public complete(id = this.requestId): void {
        this.handlers.get('heap_analysis_complete')?.({
            request_id: id, status: 'completed', summary: { total_instances: 2 },
            top_objects: [], class_histogram: [], leak_suspects: []
        });
    }
    public onNotification(method: string, handler: (params: any) => void): void { this.handlers.set(method, handler); }
    public offNotification(method: string): void { this.handlers.delete(method); }
    public async ping(): Promise<boolean> { return !this.isDisposed; }
    public die(code: number | null = null, signal: string | null = 'SIGKILL'): void {
        this.isDisposed = true;
        this.onProcessExit?.(code, signal);
        this.handlers.clear();
    }
    public dispose(): void { this.isDisposed = true; this.handlers.clear(); }
}

export async function settle(): Promise<void> { await new Promise(resolve => setImmediate(resolve)); }
