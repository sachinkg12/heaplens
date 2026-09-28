import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { LlmConfig, ChatMessage, callLlmFull } from './llmClient';
import { AI_FIX_SYSTEM_PROMPT, buildAiFixPrompt, AiFixInfo } from './promptTemplates';
import { resolveSource } from './sourceResolver';
import { formatAnalysisContext } from './analysisContext';
import type { EditorState } from './messageHandlers';
import { confirmAiSourceSharing } from './aiSourceConsent';

export interface AiFixResult {
    status: 'diff-opened' | 'already-fixed' | 'source-not-found' | 'cancelled' | 'error';
    message?: string;
}

interface AiFixContext {
    className: string;
    retainedSize: number;
    retainedPercentage: number;
    description: string;
}

function stripMarkdownFences(text: string): string {
    let result = text.trim();
    // Remove leading ```java or ```
    result = result.replace(/^```\w*\s*\n?/, '');
    // Remove trailing ```
    result = result.replace(/\n?```\s*$/, '');
    return result;
}

export async function executeAiFix(
    llmConfig: LlmConfig,
    fixContext: AiFixContext,
    state: EditorState,
    outputChannel: vscode.OutputChannel,
    webviewPanel: vscode.WebviewPanel
): Promise<AiFixResult> {
    // Bind consent to the same configuration used for the request, even across awaits.
    const requestConfig = { ...llmConfig };
    const { className, retainedSize, retainedPercentage, description } = fixContext;

    // 1. Resolve source file
    const sourceResult = await resolveSource(className);
    if (!sourceResult) {
        return { status: 'source-not-found', message: `No source file found for ${className}` };
    }

    // 2. Ask before reading/sending source. Dismissal/review grants no permission.
    const originalUri = sourceResult.uri;
    if (!await confirmAiSourceSharing(requestConfig, originalUri)) {
        return { status: 'cancelled' };
    }
    const fileBytes = await vscode.workspace.fs.readFile(originalUri);
    const sourceCode = Buffer.from(fileBytes).toString('utf-8');

    // 3. Build prompt and call LLM
    const heapContext = state.analysisData ? formatAnalysisContext(state.analysisData) : '';
    const fixInfo: AiFixInfo = {
        className,
        retainedSize,
        retainedPercentage,
        description,
        sourceCode
    };

    const userPrompt = buildAiFixPrompt(heapContext, fixInfo);
    const messages: ChatMessage[] = [
        { role: 'system', content: AI_FIX_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
    ];

    outputChannel.appendLine(`[HeapLens] AI Fix: calling LLM for ${className}`);
    let response: string;
    try {
        response = await callLlmFull(requestConfig, messages);
    } catch (err: any) {
        return { status: 'error', message: err.message || String(err) };
    }

    // 4. Check for ALREADY_FIXED marker
    if (response.trim().includes('<<<ALREADY_FIXED>>>')) {
        return { status: 'already-fixed', message: `${className} appears to already handle this leak correctly.` };
    }

    // 5. Strip markdown fences
    const fixedCode = stripMarkdownFences(response);

    // 6. Write to temp file
    const simpleName = className.split('.').pop() || className;
    const tempPath = path.join(os.tmpdir(), `${simpleName}-heaplens-fix.java`);
    const tempUri = vscode.Uri.file(tempPath);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(tempUri, encoder.encode(fixedCode));

    // 7. Open diff editor
    const title = `${simpleName}: Original \u2194 AI Fix`;
    await vscode.commands.executeCommand('vscode.diff', originalUri, tempUri, title);

    // 8. Listen for save on temp file -> apply fix to original
    const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (doc.uri.fsPath !== tempUri.fsPath) { return; }

        try {
            // Copy temp content to original
            const fixedBytes = await vscode.workspace.fs.readFile(tempUri);
            await vscode.workspace.fs.writeFile(originalUri, fixedBytes);

            // Track as fixed
            state.fixedClasses.add(className);

            // Clean up temp file
            try { await vscode.workspace.fs.delete(tempUri); } catch { /* ignore */ }

            saveDisposable.dispose();
            closeDisposable.dispose();

            // Notify webview
            webviewPanel.webview.postMessage({ command: 'classFixed', className });

            vscode.window.showInformationMessage(`HeapLens: Fix applied to ${simpleName}.java`);
            outputChannel.appendLine(`[HeapLens] AI Fix: applied fix for ${className}`);
        } catch (err: any) {
            outputChannel.appendLine(`[HeapLens] AI Fix: error applying fix: ${err.message}`);
            vscode.window.showErrorMessage(`HeapLens: Failed to apply fix: ${err.message}`);
        }
    });

    // 9. Clean up temp file when diff is closed without saving
    const closeDisposable = vscode.workspace.onDidCloseTextDocument(async (doc) => {
        if (doc.uri.fsPath !== tempUri.fsPath) { return; }
        try { await vscode.workspace.fs.delete(tempUri); } catch { /* ignore */ }
        saveDisposable.dispose();
        closeDisposable.dispose();
    });

    return { status: 'diff-opened' };
}
