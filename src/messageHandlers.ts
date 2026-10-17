import * as vscode from 'vscode';
import { RustClient } from './rustClient';
import { AnalysisData } from './analysisContext';
import { ChatMessage } from './llmClient';
import type { LlmConfig } from './llmClient';
import type { LlmConfigurationService } from './llmConfigurationService';
import type { DependencyInfo } from './dependencyResolver';

import { treeHandlers } from './handlers/treeHandlers';
import { aiHandlers } from './handlers/aiHandlers';
import { dataHandlers } from './handlers/dataHandlers';
import { progressiveHandlers } from './handlers/progressiveHandlers';
import { wasteHandlers } from './handlers/wasteHandlers';

/** Per-editor state, keyed by hprof file path. */
export interface EditorState {
    webviewPanel: vscode.WebviewPanel;
    client: RustClient;
    analysisData: AnalysisData | null;
    analysisMode?: 'full' | 'shallow';
    chatHistory: ChatMessage[];
    pendingWebviewMessage: any;
    pendingProgressMessage?: any;
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
    llmConfiguration: LlmConfigurationService;
    provider: {
        handleChatMessage(text: string, hprofPath: string, webviewPanel: vscode.WebviewPanel): Promise<void>;
        handleGoToSource(className: string, hprofPath: string, webviewPanel: vscode.WebviewPanel): Promise<void>;
        handleCopyReport(hprofPath: string, webviewPanel: vscode.WebviewPanel): void;
        clearChatHistory(hprofPath: string): void;
        handleFixWithAi(message: any, hprofPath: string, webviewPanel: vscode.WebviewPanel, llmConfig: LlmConfig): Promise<void>;
        cancelAnalysis(hprofPath: string): Promise<void>;
        retryAnalysis(hprofPath: string, mode?: 'full' | 'shallow'): Promise<void>;
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
    ...progressiveHandlers,
    ...wasteHandlers,
];
