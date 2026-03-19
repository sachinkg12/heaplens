import * as vscode from 'vscode';
import { MessageHandler } from '../messageHandlers';
import { formatAnalysisContext } from '../analysisContext';
import { streamLlmResponse, LlmConfig, ChatMessage } from '../llmClient';
import { HEAP_ANALYSIS_SYSTEM_PROMPT, buildObjectExplainPrompt, buildLeakSuspectExplainPrompt } from '../promptTemplates';
import { trackEvent } from '../telemetry';

export const explainObjectHandler: MessageHandler = {
    command: 'explainObject',
    async handle(message, ctx) {
        trackEvent('feature/explainObject');
        const config = vscode.workspace.getConfiguration('heaplens.llm');
        const llmConfig: LlmConfig = {
            provider: config.get<string>('provider', 'anthropic'),
            apiKey: config.get<string>('apiKey', ''),
            baseUrl: config.get<string>('baseUrl', '') || undefined,
            model: config.get<string>('model', '') || undefined,
        };

        const objectId = message.objectId;

        if (!llmConfig.apiKey) {
            ctx.webviewPanel.webview.postMessage({
                command: 'explainError',
                objectId,
                message: 'No API key configured. Go to Settings and search for "heaplens.llm.apiKey" to set your API key.'
            });
            return;
        }

        let gcPath: any = null;
        try {
            gcPath = await ctx.client.sendRequest('gc_root_path', {
                path: ctx.hprofPath,
                object_id: objectId
            });
        } catch {
            // ignore — GC path is optional
        }

        const heapContext = ctx.state.analysisData ? formatAnalysisContext(ctx.state.analysisData) : '';
        const totalHeapSize = ctx.state.analysisData?.summary?.total_heap_size || 0;

        const gcRootPath = Array.isArray(gcPath) ? gcPath.map((n: any) => ({
            class_name: n.class_name || n.node_type,
            field_name: n.field_name
        })) : undefined;

        const prompt = buildObjectExplainPrompt(heapContext, {
            className: message.className || '',
            shallowSize: message.shallowSize || 0,
            retainedSize: message.retainedSize || 0,
            totalHeapSize,
            fields: message.fields || [],
            gcRootPath
        });

        const messages: ChatMessage[] = [
            { role: 'system', content: HEAP_ANALYSIS_SYSTEM_PROMPT },
            { role: 'user', content: prompt }
        ];

        streamLlmResponse(
            llmConfig,
            messages,
            (chunk) => {
                ctx.webviewPanel.webview.postMessage({ command: 'explainChunk', objectId, text: chunk });
            },
            () => {
                ctx.webviewPanel.webview.postMessage({ command: 'explainDone', objectId });
            },
            (error) => {
                ctx.outputChannel.appendLine(`[HeapLens] Explain error: ${error}`);
                ctx.webviewPanel.webview.postMessage({ command: 'explainError', objectId, message: error });
            }
        );
    }
};

export const explainLeakSuspectHandler: MessageHandler = {
    command: 'explainLeakSuspect',
    async handle(message, ctx) {
        trackEvent('feature/explainLeakSuspect');
        const config = vscode.workspace.getConfiguration('heaplens.llm');
        const llmConfig: LlmConfig = {
            provider: config.get<string>('provider', 'anthropic'),
            apiKey: config.get<string>('apiKey', ''),
            baseUrl: config.get<string>('baseUrl', '') || undefined,
            model: config.get<string>('model', '') || undefined,
        };

        const className = message.className;

        if (!llmConfig.apiKey) {
            ctx.webviewPanel.webview.postMessage({
                command: 'explainLeakError',
                className,
                message: 'No API key configured. Go to Settings and search for "heaplens.llm.apiKey" to set your API key.'
            });
            return;
        }

        const heapContext = ctx.state.analysisData ? formatAnalysisContext(ctx.state.analysisData) : '';

        const prompt = buildLeakSuspectExplainPrompt(heapContext, {
            className: message.className || '',
            retainedSize: message.retainedSize || 0,
            retainedPercentage: message.retainedPercentage || 0,
            description: message.description || ''
        });

        const messages: ChatMessage[] = [
            { role: 'system', content: HEAP_ANALYSIS_SYSTEM_PROMPT },
            { role: 'user', content: prompt }
        ];

        streamLlmResponse(
            llmConfig,
            messages,
            (chunk) => {
                ctx.webviewPanel.webview.postMessage({ command: 'explainLeakChunk', className, text: chunk });
            },
            () => {
                ctx.webviewPanel.webview.postMessage({ command: 'explainLeakDone', className });
            },
            (error) => {
                ctx.outputChannel.appendLine(`[HeapLens] Explain leak error: ${error}`);
                ctx.webviewPanel.webview.postMessage({ command: 'explainLeakError', className, message: error });
            }
        );
    }
};

export const chatMessageHandler: MessageHandler = {
    command: 'chatMessage',
    async handle(message, ctx) {
        ctx.provider.handleChatMessage(message.text, ctx.hprofPath, ctx.webviewPanel);
    }
};

export const fixWithAiHandler: MessageHandler = {
    command: 'fixWithAi',
    async handle(message, ctx) {
        const config = vscode.workspace.getConfiguration('heaplens.llm');
        const apiKey = config.get<string>('apiKey', '');

        if (!apiKey && config.get<string>('provider', 'anthropic') !== 'ollama') {
            ctx.webviewPanel.webview.postMessage({
                command: 'fixWithAiError',
                className: message.className,
                message: 'No API key configured. Go to Settings and search for "heaplens.llm.apiKey" to set your API key.'
            });
            return;
        }

        ctx.webviewPanel.webview.postMessage({
            command: 'fixWithAiStarted',
            className: message.className
        });

        await ctx.provider.handleFixWithAi(message, ctx.hprofPath, ctx.webviewPanel);
    }
};

export const aiHandlers: MessageHandler[] = [
    explainObjectHandler,
    explainLeakSuspectHandler,
    chatMessageHandler,
    fixWithAiHandler,
];
