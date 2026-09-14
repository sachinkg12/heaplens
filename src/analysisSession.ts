export interface AnalysisRpcClient {
    sendRequest(method: string, params?: any, timeoutMs?: number): Promise<any>;
    onNotification(method: string, handler: (params: any) => void): void;
    offNotification(method: string): void;
}

export interface AnalysisTimer {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

export type LongRunningDecision = 'continue' | 'cancel';

export interface AnalysisSessionCallbacks {
    onProgress(params: any): void;
    onLongRunning(elapsedMs: number): Promise<LongRunningDecision>;
    onIgnoredNotification?(method: string, params: any): void;
    onCancellationError?(error: Error): void;
}

export interface AnalysisSessionOptions {
    /**
     * Delay before presenting a non-destructive long-running warning.
     * A value of zero disables the warning. This is not an analysis deadline.
     */
    longRunningWarningMs: number;
    /** Timeout for the server to acknowledge the initial JSON-RPC request. */
    initialRequestTimeoutMs?: number;
    /** Timeout for the server to acknowledge a cancellation request. */
    cancellationRequestTimeoutMs?: number;
}

export type AnalysisSessionResult =
    | { status: 'completed'; result: any }
    | { status: 'cancelled' }
    | { status: 'disposed' };

type AnalysisSessionState =
    | 'idle'
    | 'starting'
    | 'running'
    | 'cancelling'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'disposed';

const systemTimer: AnalysisTimer = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * Owns one heap-analysis job from acknowledgement through a terminal event.
 *
 * The session deliberately treats elapsed time as a reason to warn, never as
 * proof of failure. Liveness remains the responsibility of the server process
 * and heartbeat monitor. Notification handlers stay installed until the job
 * completes, fails, is cancelled, or its editor is disposed.
 */
export class AnalysisSession {
    private state: AnalysisSessionState = 'idle';
    private requestId: number | null = null;
    private startedAt = 0;
    private warningHandle: unknown;
    private cancelRequested = false;
    private cancellationSent = false;
    private pendingNotifications: Array<{ method: string; params: any }> = [];
    private resultPromise: Promise<AnalysisSessionResult> | null = null;
    private resolveResult: ((result: AnalysisSessionResult) => void) | null = null;
    private rejectResult: ((error: Error) => void) | null = null;

    private readonly progressHandler = (params: any): void => {
        if (this.queueUntilRequestKnown('heap_analysis_progress', params)) {
            return;
        }
        if (!this.isCurrentRequest(params)) {
            this.callbacks.onIgnoredNotification?.('heap_analysis_progress', params);
            return;
        }
        this.callbacks.onProgress(params);
    };

    private readonly completionHandler = (params: any): void => {
        if (this.queueUntilRequestKnown('heap_analysis_complete', params)) {
            return;
        }
        if (!this.isCurrentRequest(params)) {
            this.callbacks.onIgnoredNotification?.('heap_analysis_complete', params);
            return;
        }

        if (params?.status === 'completed') {
            this.finish({ status: 'completed', result: params }, 'completed');
            return;
        }

        if (params?.status === 'cancelled' || params?.status === 'canceled') {
            this.finish({ status: 'cancelled' }, 'cancelled');
            return;
        }

        const message = typeof params?.error === 'string'
            ? params.error
            : `Heap analysis ended with status '${String(params?.status || 'unknown')}'`;

        if (this.cancelRequested && /cancelled|canceled/i.test(message)) {
            this.finish({ status: 'cancelled' }, 'cancelled');
            return;
        }

        this.fail(new Error(message));
    };

    constructor(
        private readonly client: AnalysisRpcClient,
        private readonly hprofPath: string,
        private readonly options: AnalysisSessionOptions,
        private readonly callbacks: AnalysisSessionCallbacks,
        private readonly timer: AnalysisTimer = systemTimer
    ) {}

    /** Starts the analysis once and resolves only after a real terminal event. */
    public run(): Promise<AnalysisSessionResult> {
        if (this.resultPromise) {
            return this.resultPromise;
        }

        if (this.state === 'disposed') {
            return Promise.resolve({ status: 'disposed' });
        }

        this.resultPromise = new Promise<AnalysisSessionResult>((resolve, reject) => {
            this.resolveResult = resolve;
            this.rejectResult = reject;
        });

        this.state = 'starting';
        this.startedAt = Date.now();
        this.client.onNotification('heap_analysis_progress', this.progressHandler);
        this.client.onNotification('heap_analysis_complete', this.completionHandler);
        void this.begin();

        return this.resultPromise;
    }

    /** Requests cooperative cancellation without discarding the terminal result. */
    public async cancel(): Promise<void> {
        if (this.isTerminal()) {
            return;
        }

        this.cancelRequested = true;
        this.clearWarning();

        // The initial request may not have been acknowledged yet. begin() will
        // send cancellation once the analysis request ID is known.
        if (this.requestId === null) {
            return;
        }

        await this.sendCancellation();
    }

    /** Marks the job failed when the owning server process exits. */
    public serverExited(error: Error): void {
        if (!this.isTerminal()) {
            this.fail(error);
        }
    }

    /** Releases an editor-owned session without surfacing a user-facing error. */
    public dispose(): void {
        if (this.isTerminal()) {
            return;
        }
        this.finish({ status: 'disposed' }, 'disposed');
    }

    public get activeRequestId(): number | null {
        return this.requestId;
    }

    private async begin(): Promise<void> {
        try {
            const response = await this.client.sendRequest(
                'analyze_heap',
                { path: this.hprofPath },
                this.options.initialRequestTimeoutMs ?? 30_000
            );

            if (this.isTerminal()) {
                return;
            }
            if (response?.status !== 'processing' || !Number.isSafeInteger(response?.request_id)) {
                throw new Error('Analysis server returned an invalid processing acknowledgement');
            }

            this.requestId = response.request_id;
            this.flushPendingNotifications();
            if (this.isTerminal()) {
                return;
            }
            if (this.cancelRequested) {
                await this.sendCancellation();
                return;
            }

            this.state = 'running';
            this.scheduleLongRunningWarning();
        } catch (error) {
            this.fail(asError(error));
        }
    }

    private async sendCancellation(): Promise<void> {
        if (this.cancellationSent || this.isTerminal()) {
            return;
        }

        this.cancellationSent = true;
        this.state = 'cancelling';
        try {
            await this.client.sendRequest(
                'cancel_analysis',
                { path: this.hprofPath, analysis_request_id: this.requestId },
                this.options.cancellationRequestTimeoutMs ?? 30_000
            );
            // The acknowledgement only means that the cancel flag was set.
            // The completion notification is the authoritative terminal event.
        } catch (error) {
            // A failed cancellation request must not detach the listeners or
            // discard a result from an analysis that is still running.
            this.cancellationSent = false;
            if (!this.isTerminal()) {
                this.state = 'running';
            }
            this.callbacks.onCancellationError?.(asError(error));
        }
    }

    private scheduleLongRunningWarning(): void {
        const warningMs = this.options.longRunningWarningMs;
        if (!Number.isFinite(warningMs) || warningMs <= 0) {
            return;
        }

        this.warningHandle = this.timer.setTimeout(() => {
            this.warningHandle = undefined;
            if (this.state !== 'running') {
                return;
            }

            const elapsedMs = Math.max(warningMs, Date.now() - this.startedAt);
            void this.callbacks.onLongRunning(elapsedMs)
                .then(decision => {
                    if (decision === 'cancel' && this.state === 'running') {
                        void this.cancel();
                    }
                })
                .catch(error => this.callbacks.onCancellationError?.(asError(error)));
        }, warningMs);
    }

    private isCurrentRequest(params: any): boolean {
        const notificationRequestId = params?.request_id;
        if (!Number.isSafeInteger(notificationRequestId)) {
            // Accept ID-less notifications for backward compatibility with
            // older bundled server binaries.
            return true;
        }
        return notificationRequestId === this.requestId;
    }

    private queueUntilRequestKnown(method: string, params: any): boolean {
        if (this.requestId !== null || !Number.isSafeInteger(params?.request_id)) {
            return false;
        }
        this.pendingNotifications.push({ method, params });
        return true;
    }

    private flushPendingNotifications(): void {
        const pending = this.pendingNotifications.splice(0);
        for (const notification of pending) {
            if (this.isTerminal()) {
                break;
            }
            if (notification.method === 'heap_analysis_progress') {
                this.progressHandler(notification.params);
            } else {
                this.completionHandler(notification.params);
            }
        }
    }

    private fail(error: Error): void {
        if (this.isTerminal()) {
            return;
        }

        this.state = 'failed';
        this.cleanup();
        this.rejectResult?.(error);
        this.clearResolvers();
    }

    private finish(result: AnalysisSessionResult, state: AnalysisSessionState): void {
        if (this.isTerminal()) {
            return;
        }

        this.state = state;
        this.cleanup();
        this.resolveResult?.(result);
        this.clearResolvers();
    }

    private cleanup(): void {
        this.clearWarning();
        this.pendingNotifications = [];
        this.client.offNotification('heap_analysis_progress');
        this.client.offNotification('heap_analysis_complete');
    }

    private clearWarning(): void {
        if (this.warningHandle !== undefined) {
            this.timer.clearTimeout(this.warningHandle);
            this.warningHandle = undefined;
        }
    }

    private clearResolvers(): void {
        this.resolveResult = null;
        this.rejectResult = null;
    }

    private isTerminal(): boolean {
        return this.state === 'completed'
            || this.state === 'cancelled'
            || this.state === 'failed'
            || this.state === 'disposed';
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
