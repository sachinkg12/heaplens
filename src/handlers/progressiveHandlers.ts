import { MessageHandler } from '../messageHandlers';

/** Explicit mode changes. Ordinary object actions never request escalation. */
export const progressiveHandlers: MessageHandler[] = [
    { command: 'quickScan', async handle(_message, ctx) { await ctx.provider.retryAnalysis(ctx.hprofPath, 'shallow'); } },
    { command: 'analyzeRetained', async handle(_message, ctx) { await ctx.provider.retryAnalysis(ctx.hprofPath, 'full'); } }
];
