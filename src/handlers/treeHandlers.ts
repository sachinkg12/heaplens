import { MessageHandler } from '../messageHandlers';
import { trackEvent } from '../telemetry';

export const getChildrenHandler: MessageHandler = {
    command: 'getChildren',
    async handle(message, ctx) {
        ctx.outputChannel.appendLine(`[HeapLens] getChildren request for objectId: ${message.objectId}`);
        try {
            const children = await ctx.client.sendRequest('get_children', {
                path: ctx.hprofPath,
                object_id: message.objectId
            });
            ctx.outputChannel.appendLine(`[HeapLens] getChildren response: ${Array.isArray(children) ? children.length + ' children' : typeof children}`);
            if (Array.isArray(children) && children.length > 0) {
                ctx.outputChannel.appendLine(`[HeapLens] Sending childrenResponse with ${children.length} children`);
                ctx.webviewPanel.webview.postMessage({
                    command: 'childrenResponse',
                    objectId: message.objectId,
                    children
                });
            } else {
                ctx.outputChannel.appendLine(`[HeapLens] No children, sending noChildren`);
                ctx.webviewPanel.webview.postMessage({
                    command: 'noChildren',
                    objectId: message.objectId,
                    message: 'This object has no children in the dominator tree'
                });
            }
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] getChildren error: ${error.message}`);
            ctx.webviewPanel.webview.postMessage({
                command: 'noChildren',
                objectId: message.objectId,
                message: error.message?.includes('not found')
                    ? 'This object has no children'
                    : error.message || String(error)
            });
        }
    }
};

export const getReferrersHandler: MessageHandler = {
    command: 'getReferrers',
    async handle(message, ctx) {
        ctx.outputChannel.appendLine(`[HeapLens] getReferrers request for objectId: ${message.objectId}`);
        try {
            const referrers = await ctx.client.sendRequest('get_referrers', {
                path: ctx.hprofPath,
                object_id: message.objectId
            });
            ctx.webviewPanel.webview.postMessage({
                command: 'referrersResponse',
                objectId: message.objectId,
                referrers: Array.isArray(referrers) ? referrers : []
            });
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] getReferrers error: ${error.message}`);
            ctx.webviewPanel.webview.postMessage({
                command: 'referrersResponse',
                objectId: message.objectId,
                referrers: []
            });
        }
    }
};

export const gcRootPathHandler: MessageHandler = {
    command: 'gcRootPath',
    async handle(message, ctx) {
        trackEvent('feature/gcRootPath');
        ctx.outputChannel.appendLine(`[HeapLens] gcRootPath request for objectId: ${message.objectId}`);
        try {
            const gcPath = await ctx.client.sendRequest('gc_root_path', {
                path: ctx.hprofPath,
                object_id: message.objectId
            });
            ctx.webviewPanel.webview.postMessage({
                command: 'gcRootPathResponse',
                path: gcPath
            });
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] gcRootPath error: ${error.message}`);
            ctx.webviewPanel.webview.postMessage({
                command: 'gcRootPathResponse',
                path: null
            });
        }
    }
};

export const inspectObjectHandler: MessageHandler = {
    command: 'inspectObject',
    async handle(message, ctx) {
        trackEvent('feature/inspectObject');
        ctx.outputChannel.appendLine(`[HeapLens] inspectObject request for objectId: ${message.objectId}`);
        try {
            const fields = await ctx.client.sendRequest('inspect_object', {
                path: ctx.hprofPath,
                object_id: message.objectId
            });
            ctx.webviewPanel.webview.postMessage({
                command: 'inspectObjectResponse',
                objectId: message.objectId,
                fields: fields
            });
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] inspectObject error: ${error.message}`);
            ctx.webviewPanel.webview.postMessage({
                command: 'inspectObjectResponse',
                objectId: message.objectId,
                fields: null
            });
        }
    }
};

export const getDominatorSubtreeHandler: MessageHandler = {
    command: 'getDominatorSubtree',
    async handle(message, ctx) {
        ctx.outputChannel.appendLine(`[HeapLens] getDominatorSubtree request for objectId: ${message.objectId}`);
        try {
            const subtree = await ctx.client.sendRequest('get_dominator_subtree', {
                path: ctx.hprofPath,
                object_id: message.objectId || 0,
                max_depth: message.maxDepth || 6,
                max_children: message.maxChildren || 20
            });
            ctx.webviewPanel.webview.postMessage({
                command: 'dominatorSubtreeResponse',
                subtree
            });
        } catch (error: any) {
            ctx.outputChannel.appendLine(`[HeapLens] getDominatorSubtree error: ${error.message}`);
            ctx.webviewPanel.webview.postMessage({
                command: 'dominatorSubtreeResponse',
                subtree: null
            });
        }
    }
};

export const treeHandlers: MessageHandler[] = [
    getChildrenHandler,
    getReferrersHandler,
    gcRootPathHandler,
    inspectObjectHandler,
    getDominatorSubtreeHandler,
];
