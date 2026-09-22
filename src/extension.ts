import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { HprofEditorProvider } from './hprofEditorProvider';
import { registerChatParticipant } from './chatParticipant';
import { DependencyResolver } from './dependencyResolver';
import { setDependencyResolver } from './sourceResolver';
import { initTelemetry, disposeTelemetry, trackEvent } from './telemetry';
import {
    createVscodeLlmConfiguration,
    registerLlmCredentialCommands
} from './vscodeLlmConfiguration';

let outputChannel: vscode.OutputChannel | null = null;
let editorProvider: HprofEditorProvider | null = null;
let depResolver: DependencyResolver | null = null;

/**
 * Returns the path to the hprof-server binary.
 */
function getHprofServerPath(): string {
    const platform = process.platform;
    const extensionPath = path.dirname(__dirname);

    const devPath = path.join(extensionPath, 'hprof-analyzer', 'target', 'release',
        platform === 'win32' ? 'hprof-server.exe' : 'hprof-server');
    const prodPath = path.join(extensionPath, 'bin',
        platform === 'win32' ? 'hprof-server.exe' : 'hprof-server');

    if (fs.existsSync(prodPath)) { return prodPath; }
    return devPath; // fallback to dev path (will show a helpful error if missing)
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('HeapLens');
    outputChannel.appendLine('HeapLens extension activated');

    initTelemetry(context);

    const llmConfiguration = createVscodeLlmConfiguration(context);
    registerLlmCredentialCommands(context, llmConfiguration);
    void llmConfiguration.migrateLegacyApiKey().catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[HeapLens] LLM credential migration failed: ${message}`);
        vscode.window.showWarningMessage(
            'HeapLens could not migrate the existing API key to secure storage. ' +
            'The plaintext setting was left unchanged.'
        );
    });

    // Register custom editor for .hprof files
    editorProvider = new HprofEditorProvider(
        context,
        outputChannel,
        getHprofServerPath,
        llmConfiguration
    );
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            HprofEditorProvider.viewType,
            editorProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Register chat participant for Copilot Chat integration
    registerChatParticipant(context, () => editorProvider?.getAnalysisData() ?? null);

    // Set up dependency resolver for source code bridge Tier 2
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        depResolver = new DependencyResolver(workspaceFolder.uri.fsPath, outputChannel, context.globalStorageUri.fsPath);
        setDependencyResolver(depResolver);
    }

    // Command: Analyze HPROF file (opens file picker, then opens as custom editor)
    context.subscriptions.push(
        vscode.commands.registerCommand('heaplens.analyzeFile', async () => {
            const fileUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'HPROF Files': ['hprof'] },
                openLabel: 'Analyze HPROF File'
            });

            if (!fileUri || fileUri.length === 0) { return; }

            // Open the file with our custom editor
            await vscode.commands.executeCommand(
                'vscode.openWith',
                fileUri[0],
                HprofEditorProvider.viewType
            );
        })
    );

    // Command: Export analysis to JSON
    context.subscriptions.push(
        vscode.commands.registerCommand('heaplens.exportJson', async () => {
            const client = editorProvider?.getRustClient();
            if (!client || client.isDisposed) {
                vscode.window.showWarningMessage('HeapLens: No active analysis. Open an HPROF file first.');
                return;
            }

            // Get the currently analyzed file path from analysis state
            const fileUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'HPROF Files': ['hprof'] },
                openLabel: 'Select analyzed HPROF file'
            });

            if (!fileUri || fileUri.length === 0) { return; }

            const saveUri = await vscode.window.showSaveDialog({
                filters: { 'JSON': ['json'] },
                defaultUri: vscode.Uri.file(fileUri[0].fsPath.replace(/\.hprof$/, '-analysis.json'))
            });

            if (!saveUri) { return; }

            try {
                const result = await client.sendRequest('export_json', {
                    path: fileUri[0].fsPath,
                    output_path: saveUri.fsPath
                });

                if (result.success) {
                    trackEvent('feature/export', { format: 'json' });
                    vscode.window.showInformationMessage(`HeapLens: Analysis exported to ${saveUri.fsPath}`);
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`HeapLens: Export failed: ${error.message}`);
            }
        })
    );

    // Command: Start JVM Monitor (convenience — can also connect from the Monitor tab UI)
    context.subscriptions.push(
        vscode.commands.registerCommand('heaplens.startMonitor', async () => {
            if (!editorProvider) {
                vscode.window.showWarningMessage('HeapLens: Open an HPROF file first, then use the Monitor tab to connect.');
                return;
            }

            const defaultPort = vscode.workspace.getConfiguration('heaplens.monitor')
                .get<number>('defaultPort', 9095);
            const input = await vscode.window.showInputBox({
                prompt: 'Enter agent address (host:port)',
                value: `localhost:${defaultPort}`,
                placeHolder: 'localhost:9095'
            });
            if (!input) { return; }

            const parts = input.split(':');
            const host = parts[0] || 'localhost';
            const port = parseInt(parts[1] || String(defaultPort), 10);

            editorProvider.startMonitorFromCommand(host, port);
        })
    );

    // Cleanup
    context.subscriptions.push({
        dispose: () => {
            disposeTelemetry();
            setDependencyResolver(null);
            depResolver?.dispose();
            depResolver = null;
            editorProvider?.dispose();
            editorProvider = null;
            outputChannel?.dispose();
            outputChannel = null;
        }
    });
}

export function deactivate() {
    disposeTelemetry();
    setDependencyResolver(null);
    depResolver?.dispose();
    depResolver = null;
    editorProvider?.dispose();
    editorProvider = null;
    outputChannel?.dispose();
    outputChannel = null;
}
