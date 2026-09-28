/** Process ownership only. Analysis jobs and IDE rendering stay outside this component. */
export interface ServerProcessClient {
    readonly isDisposed: boolean;
    onProcessExit?: (code: number | null, signal: string | null) => void;
    onProcessError?: (error: Error) => void;
    onStderr?: (message: string) => void;
    ping(timeoutMs?: number): Promise<boolean>;
    dispose(): void;
}

export interface HeartbeatTimer {
    setInterval(callback: () => void, milliseconds: number): unknown;
    clearInterval(handle: unknown): void;
}

interface ConnectionCallbacks<C> {
    onUnavailable(client: C, error: Error, code: number | null, signal: string | null): void;
    onStderr(message: string): void;
    onHeartbeatFailure(count: number): void;
}

const systemTimer: HeartbeatTimer = {
    setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
    clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>)
};

/**
 * Owns at most one process for one editor. Reconnect is explicit, never an
 * automatic crash loop. Client identity fences late exits and in-flight pings.
 */
export class EditorServerConnection<C extends ServerProcessClient> {
    private client: C | null = null;
    private disposed = false;
    private heartbeat: unknown;
    private pingInFlight = false;
    private failures = 0;

    constructor(
        private readonly create: () => C,
        private readonly callbacks: ConnectionCallbacks<C>,
        private readonly timer: HeartbeatTimer = systemTimer
    ) {}

    public connect(): C {
        if (this.disposed) { throw new Error('Editor connection is closed'); }
        if (this.client && !this.client.isDisposed) { return this.client; }
        this.release();
        const client = this.create(); // A failed spawn leaves the connection retryable.
        this.client = client;
        client.onStderr = message => {
            if (this.isCurrent(client)) { this.callbacks.onStderr(message); }
        };
        client.onProcessExit = (code, signal) => this.unavailable(
            client, new Error(`Analysis server exited with code ${code}, signal ${signal}`), code, signal
        );
        client.onProcessError = error => this.unavailable(client, error, null, null);
        this.heartbeat = this.timer.setInterval(() => { void this.checkHeartbeat(client); }, 15_000);
        return client;
    }

    public isCurrent(client: C): boolean { return !this.disposed && this.client === client; }

    public dispose(): void {
        this.disposed = true;
        this.release();
    }

    private unavailable(client: C, error: Error, code: number | null, signal: string | null): void {
        if (!this.isCurrent(client)) { return; }
        this.release();
        this.callbacks.onUnavailable(client, error, code, signal);
    }

    private release(): void {
        const old = this.client;
        this.client = null; // Invalidate ownership before disposal can produce an exit.
        if (this.heartbeat !== undefined) { this.timer.clearInterval(this.heartbeat); }
        this.heartbeat = undefined;
        this.failures = 0;
        this.pingInFlight = false;
        if (old) {
            old.onProcessExit = undefined;
            old.onProcessError = undefined;
            old.onStderr = undefined;
            old.dispose();
        }
    }

    private async checkHeartbeat(client: C): Promise<void> {
        if (!this.isCurrent(client) || client.isDisposed || this.pingInFlight) { return; }
        this.pingInFlight = true;
        let ok = false;
        try { ok = await client.ping(5_000); } catch { /* Treat a rejected ping as a failed ping. */ }
        if (!this.isCurrent(client)) { return; }
        this.pingInFlight = false;
        this.failures = ok ? 0 : this.failures + 1;
        if (!ok) { this.callbacks.onHeartbeatFailure(this.failures); }
        // An unresponsive but live server is not proof of death. Never kill it here.
    }
}
