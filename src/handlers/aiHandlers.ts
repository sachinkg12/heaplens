import { MessageHandler } from '../messageHandlers';
import { LlmConfig } from '../llmClient';
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
        await ctx.provider.handleExplain(message,'object',ctx.hprofPath,ctx.webviewPanel);
    }
};

export const explainLeakSuspectHandler: MessageHandler = {
    command: 'explainLeakSuspect',
    async handle(message, ctx) {
        trackEvent('feature/explainLeakSuspect');
        await ctx.provider.handleExplain(message,'leak',ctx.hprofPath,ctx.webviewPanel);
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
    {command:'stopAi',async handle(_message,ctx){ctx.provider.stopAi(ctx.hprofPath);}},
    {command:'openAiEvidence',async handle(message,ctx){ctx.provider.openAiEvidence(message.id,ctx.hprofPath,ctx.webviewPanel);}},
];
