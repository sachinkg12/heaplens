import * as vscode from 'vscode';
import { AnalysisStorageOptions, analysisStorageOptions } from './analysisStorage';

/** Resource policy comes from application/user settings, never a workspace. */
export function readAnalysisStorage(): AnalysisStorageOptions {
    const settings = vscode.workspace.getConfiguration('heaplens');
    const global = (name: string): unknown => {
        const values = settings.inspect?.<unknown>(name);
        return values?.globalValue ?? values?.defaultValue;
    };
    return analysisStorageOptions(global('analysis.storage'), global('analysis.edgeBufferMiB'));
}

export function registerAnalysisStorage(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand('heaplens.configureAnalysisStorage', async () => {
        const current = readAnalysisStorage();
        const choices = [
            { label: 'Memory storage', description: 'Default; no persistent reference index', detail: 'Usually faster on first load. Full graph references are stored in RAM.', mode: 'memory' as const },
            { label: 'Disk-backed references', description: 'Private reusable indices; less reference-building RAM', detail: 'First load can be slower. Nodes and exact dominators still need RAM; this is not a total-memory limit.', mode: 'disk' as const }
        ];
        const selected = await vscode.window.showQuickPick(choices, {
            title: `HeapLens analysis storage (current: ${current.mode})`,
            placeHolder: 'Applies to newly started servers. Close and reopen existing dump editors after changing.'
        });
        if (!selected || selected.mode === current.mode) { return; }
        try {
            await vscode.workspace.getConfiguration('heaplens').update('analysis.storage', selected.mode, vscode.ConfigurationTarget.Global);
            void vscode.window.showInformationMessage('HeapLens storage preference saved. Close and reopen existing dump editors to use it. Cache location is managed automatically.');
        } catch {
            void vscode.window.showErrorMessage('HeapLens could not save the analysis storage preference. No analysis was restarted.');
        }
    }));
}
