import * as vscode from 'vscode';
import { RustClient } from './rustClient';
import { AnalysisData } from './analysisContext';
import { ChatMessage } from './llmClient';
import type { DependencyInfo } from './dependencyResolver';

import { treeHandlers } from './handlers/treeHandlers';
import { aiHandlers } from './handlers/aiHandlers';
import { dataHandlers } from './handlers/dataHandlers';

/** Per-editor state, keyed by hprof file path. */
export interface EditorState {
    webviewPanel: vscode.WebviewPanel;
    client: RustClient;
    analysisData: AnalysisData | null;
    chatHistory: ChatMessage[];
    pendingWebviewMessage: any;
    webviewReady: boolean;
    dependencyInfoCache: Map<string, { tier: string; dependency?: DependencyInfo }>;
    fixedClasses: Set<string>;
}

export interface HandlerContext {
    hprofPath: string;
    state: EditorState;
    webviewPanel: vscode.WebviewPanel;
    client: RustClient;
    outputChannel: vscode.OutputChannel;
    provider: {
        handleChatMessage(text: string, hprofPath: string, webviewPanel: vscode.WebviewPanel): void;
        handleGoToSource(className: string, hprofPath: string, webviewPanel: vscode.WebviewPanel): Promise<void>;
        handleCopyReport(hprofPath: string, webviewPanel: vscode.WebviewPanel): void;
        clearChatHistory(hprofPath: string): void;
        handleFixWithAi(message: any, hprofPath: string, webviewPanel: vscode.WebviewPanel): Promise<void>;
    };
}

export interface MessageHandler {
    command: string;
    handle(message: any, ctx: HandlerContext): Promise<void>;
}

export { extractQueryKeyword } from './telemetry';

export const allHandlers: MessageHandler[] = [
    ...treeHandlers,
    ...aiHandlers,
    ...dataHandlers,
];
