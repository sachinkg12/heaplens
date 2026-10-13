import { MessageHandler } from '../messageHandlers';

/** Content work is explicit and bound to the originating analysis/client. */
export const wasteHandlers: MessageHandler[] = [{
    command: 'calculateWaste',
    async handle(message, ctx) {
        const id = message.requestId;
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) { return; }
        const original = ctx.state.analysisData;
        const active = () => ctx.state.client === ctx.client && ctx.state.analysisData === original;
        try {
            if (!original || ctx.state.analysisMode === 'shallow') { throw new Error('unavailable'); }
            const waste = await ctx.client.sendRequest('get_waste_analysis', { path: ctx.hprofPath });
            if (!active()) { return; }
            original.wasteAnalysis = waste;
            ctx.webviewPanel.webview.postMessage({ command: 'wasteResult', requestId: id, wasteAnalysis: waste });
        } catch {
            if (active()) {
                ctx.webviewPanel.webview.postMessage({ command: 'wasteError', requestId: id, error: 'Waste analysis unavailable. Retry after retained analysis completes.' });
            }
        }
    }
}];
