import { MessageHandler } from '../messageHandlers';
import { formatAnalysisContext } from '../analysisContext';
import { streamLlmResponse, LlmConfig, ChatMessage } from '../llmClient';
import { HEAP_ANALYSIS_SYSTEM_PROMPT, buildObjectExplainPrompt, buildLeakSuspectExplainPrompt } from '../promptTemplates';
import { trackEvent } from '../telemetry';

const MISSING_API_KEY_MESSAGE =
    'No API key configured. Run "HeapLens: Set LLM API Key" from the Command Palette.';

async function loadLlmConfig(ctx: Parameters<MessageHandler['handle']>[1]): Promise<LlmConfig | null> {
    try {
        return await ctx.llmConfiguration.getConfig();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.outputChannel.appendLine(`[HeapLens] Secure credential access failed: ${message}`);
        return null;
    }
}

export const explainObjectHandler: MessageHandler = {
    command: 'explainObject',
    async handle(message, ctx) {
        trackEvent('feature/explainObject');
        const llmConfig = await loadLlmConfig(ctx);

        const objectId = message.objectId;

        if (!llmConfig) {
            ctx.webviewPanel.webview.postMessage({
                command: 'explainError',
                objectId,
                message: 'Secure credential storage is unavailable. See the HeapLens output for details.'
            });
            return;
        }

        if (!llmConfig.apiKey && llmConfig.provider !== 'ollama') {
            ctx.webviewPanel.webview.postMessage({
                command: 'explainError',
                objectId,
                message: MISSING_API_KEY_MESSAGE
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
        const llmConfig = await loadLlmConfig(ctx);

        const className = message.className;
        const objectId = message.objectId || 0;

        if (!llmConfig) {
            ctx.webviewPanel.webview.postMessage({
                command: 'explainLeakError',
                className,
                objectId,
                message: 'Secure credential storage is unavailable. See the HeapLens output for details.'
            });
            return;
        }

        if (!llmConfig.apiKey && llmConfig.provider !== 'ollama') {
            ctx.webviewPanel.webview.postMessage({
                command: 'explainLeakError',
                className,
                objectId,
                message: MISSING_API_KEY_MESSAGE
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
                ctx.webviewPanel.webview.postMessage({ command: 'explainLeakChunk', className, objectId, text: chunk });
            },
            () => {
                ctx.webviewPanel.webview.postMessage({ command: 'explainLeakDone', className, objectId });
            },
            (error) => {
                ctx.outputChannel.appendLine(`[HeapLens] Explain leak error: ${error}`);
                ctx.webviewPanel.webview.postMessage({ command: 'explainLeakError', className, objectId, message: error });
            }
        );
    }
};

export const chatMessageHandler: MessageHandler = {
    command: 'chatMessage',
    async handle(message, ctx) {
        await ctx.provider.handleChatMessage(message.text, ctx.hprofPath, ctx.webviewPanel);
    }
};

export const fixWithAiHandler: MessageHandler = {
    command: 'fixWithAi',
    async handle(message, ctx) {
        const llmConfig = await loadLlmConfig(ctx);

        if (!llmConfig) {
            ctx.webviewPanel.webview.postMessage({
                command: 'fixWithAiError',
                className: message.className,
                message: 'Secure credential storage is unavailable. See the HeapLens output for details.'
            });
            return;
        }

        if (!llmConfig.apiKey && llmConfig.provider !== 'ollama') {
            ctx.webviewPanel.webview.postMessage({
                command: 'fixWithAiError',
                className: message.className,
                message: MISSING_API_KEY_MESSAGE
            });
            return;
        }

        ctx.webviewPanel.webview.postMessage({
            command: 'fixWithAiStarted',
            className: message.className
        });

        await ctx.provider.handleFixWithAi(message, ctx.hprofPath, ctx.webviewPanel, llmConfig);
    }
};

export const aiHandlers: MessageHandler[] = [
    explainObjectHandler,
    explainLeakSuspectHandler,
    chatMessageHandler,
    fixWithAiHandler,
];
