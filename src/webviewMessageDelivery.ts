/** Minimal state required to deliver one terminal analysis message to a webview. */
export interface BufferedWebviewMessageState {
    webviewReady: boolean;
    pendingWebviewMessage: any;
}

export type WebviewMessageDelivery = 'posted' | 'buffered';

/**
 * Posts a terminal analysis message immediately when possible, otherwise keeps
 * it until the webview announces that its message handlers are installed.
 */
export function deliverOrBufferWebviewMessage(
    state: BufferedWebviewMessageState,
    message: any,
    postMessage: (message: any) => unknown
): WebviewMessageDelivery {
    if (state.webviewReady) {
        postMessage(message);
        return 'posted';
    }

    state.pendingWebviewMessage = message;
    return 'buffered';
}

/** Marks the webview ready and delivers a buffered terminal message once. */
export function markWebviewReadyAndFlush(
    state: BufferedWebviewMessageState,
    postMessage: (message: any) => unknown
): any | null {
    state.webviewReady = true;
    const pendingMessage = state.pendingWebviewMessage;
    if (!pendingMessage) {
        return null;
    }

    state.pendingWebviewMessage = null;
    postMessage(pendingMessage);
    return pendingMessage;
}
