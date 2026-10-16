/** Minimal state required to deliver one terminal analysis message to a webview. */
export interface BufferedWebviewMessageState {
    webviewReady: boolean;
    pendingWebviewMessage: any;
    pendingProgressMessage?: any;
}

export type WebviewMessageDelivery = 'posted' | 'buffered';

/** A handler started on an old server must not overwrite the replacement's UI. */
export function guardWebviewMessages<T extends { webview: { postMessage(message: any): PromiseLike<boolean> } }>(
    panel: T, isCurrent: () => boolean
): T {
    const webview = new Proxy(panel.webview, {
        get(target, property) {
            if (property === 'postMessage') {
                return (message: any) => isCurrent() ? target.postMessage(message) : Promise.resolve(false);
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
    return new Proxy(panel, {
        get(target, property) {
            if (property === 'webview') { return webview; }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

/**
 * Posts a terminal analysis message immediately when possible, otherwise keeps
 * it until the webview announces that its message handlers are installed.
 */
export function deliverOrBufferWebviewMessage(
    state: BufferedWebviewMessageState,
    message: any,
    postMessage: (message: any) => unknown
): WebviewMessageDelivery {
    if (message.command === 'analysisStarting') { state.pendingProgressMessage = null; }
    if (['analysisComplete','shallowScanComplete','analysisFailed','analysisCancelled','serverCrashed'].includes(message.command)) {
        state.pendingProgressMessage = null;
    }
    if (state.webviewReady) {
        postMessage(message);
        return 'posted';
    }

    state.pendingWebviewMessage = message;
    return 'buffered';
}

/** Keep one coalesced snapshot, not an unbounded backlog while HTML loads. */
export function deliverOrBufferProgress(
    state: BufferedWebviewMessageState, message: any, postMessage: (message: any) => unknown
): void {
    if (state.webviewReady) { postMessage(message); return; }
    state.pendingProgressMessage = { ...state.pendingProgressMessage, ...message };
}

/** Marks the webview ready and delivers a buffered terminal message once. */
export function markWebviewReadyAndFlush(
    state: BufferedWebviewMessageState,
    postMessage: (message: any) => unknown
): any | null {
    state.webviewReady = true;
    const pendingMessage = state.pendingWebviewMessage;
    state.pendingWebviewMessage = null;
    if (pendingMessage) { postMessage(pendingMessage); }
    if (state.pendingProgressMessage) {
        postMessage(state.pendingProgressMessage);
        state.pendingProgressMessage = null;
    }
    return pendingMessage;
}
