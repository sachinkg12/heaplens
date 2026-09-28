import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';

/**
 * JSON-RPC 2.0 Request structure.
 */
interface JsonRpcRequest {
    jsonrpc: string;
    id: number;
    method: string;
    params?: any;
}

/**
 * JSON-RPC 2.0 Response structure.
 */
interface JsonRpcResponse {
    jsonrpc: string;
    id: number;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

/**
 * JSON-RPC 2.0 Notification structure (no id field).
 */
interface JsonRpcNotification {
    jsonrpc: string;
    method: string;
    params: any;
}

/**
 * Pending request tracking.
 */
interface PendingRequest {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
}

/**
 * RustClient - Communicates with the async Rust hprof-server binary.
 * 
 * This client:
 * - Spawns the Rust binary process
 * - Listens to stdout and splits by newline to decode JSON messages
 * - Handles both JSON-RPC responses and notifications
 * - Implements sendRequest that returns a Promise resolving when the corresponding ID is received
 */
export class RustClient {
    private requestId = 0;
    private pendingRequests: Map<number, PendingRequest> = new Map();
    private notificationHandlers: Map<string, (params: any) => void> = new Map();
    private rl: readline.Interface;
    private process: ChildProcess;
    private isShutdown = false;
    public onStderr?: (message: string) => void;
    public onProcessExit?: (code: number | null, signal: string | null) => void;
    public onProcessError?: (error: Error) => void;

    /**
     * Creates a new RustClient instance.
     * 
     * @param binaryPath - Path to the Rust binary (hprof-server)
     */
    constructor(binaryPath: string) {
        console.log(`[RustClient] Spawning: ${binaryPath}`);
        // Spawn the Rust process
        this.process = spawn(binaryPath, [], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        console.log(`[RustClient] Process spawned, pid: ${this.process.pid}`);

        // Create readline interface to split stdout by newlines
        this.rl = readline.createInterface({
            input: this.process.stdout!,
            crlfDelay: Infinity
        });

        // Handle each line from stdout
        this.rl.on('line', (line: string) => {
            console.log(`[RustClient] Received line (${line.length} chars): ${line.substring(0, 200)}...`);
            this.handleMessage(line);
        });

        // Handle stderr - will be logged to output channel if provided
        this.process.stderr?.on('data', (data: Buffer) => {
            const message = data.toString();
            console.error(`[Rust server stderr] ${message}`);
            // Also emit an event so extension can log it
            if (this.onStderr) {
                this.onStderr(message);
            }
        });

        // Handle process exit
        this.process.on('exit', (code: number | null, signal: string | null) => {
            console.log(`[RustClient] Process exited: code=${code}, signal=${signal}`);
            if (this.isShutdown) { return; } // Intentional disposal is not a crash.
            this.shutdown(
                code !== 0
                    ? new Error(`Rust process exited with code ${code}, signal ${signal}`)
                    : null
            );
            this.onProcessExit?.(code, signal);
        });

        // Handle process errors
        this.process.on('error', (error: Error) => {
            console.error(`[RustClient] Process error: ${error.message}`);
            if (this.isShutdown) { return; }
            this.shutdown(error);
            this.onProcessError?.(error); // Spawn errors need not emit an exit event.
        });
    }

    /**
     * Handles a message from the Rust server.
     * Messages can be either JSON-RPC responses or notifications.
     */
    private handleMessage(line: string): void {
        if (this.isShutdown || !line.trim()) {
            return;
        }

        try {
            const message = JSON.parse(line);
            
            // Log notifications for debugging
            if (!('id' in message)) {
                console.log(`[RustClient] Received notification: ${(message as JsonRpcNotification).method}`);
            }

            // Check if it's a notification (no id field)
            if (!('id' in message)) {
                this.handleNotification(message as JsonRpcNotification);
                return;
            }

            // It's a response (has id field)
            const response = message as JsonRpcResponse;

            if (response.jsonrpc !== '2.0') {
                console.error(`Invalid JSON-RPC version: ${response.jsonrpc}`);
                return;
            }

            const pending = this.pendingRequests.get(response.id);
            if (!pending) {
                // Might be a response we're not waiting for, log but don't error
                console.warn(`No pending request found for ID ${response.id}`);
                return;
            }

            this.pendingRequests.delete(response.id);

            if (response.error) {
                pending.reject(
                    new Error(`JSON-RPC error: ${response.error.message} (code: ${response.error.code})`)
                );
            } else {
                pending.resolve(response.result);
            }
        } catch (error) {
            console.error(`Failed to parse JSON message: ${line}`, error);
        }
    }

    /**
     * Handles a JSON-RPC notification from the server.
     */
    private handleNotification(notification: JsonRpcNotification): void {
        if (notification.jsonrpc !== '2.0') {
            console.error(`Invalid JSON-RPC version in notification: ${notification.jsonrpc}`);
            return;
        }

        const handler = this.notificationHandlers.get(notification.method);
        if (handler) {
            handler(notification.params);
        } else {
            console.warn(`No handler registered for notification method: ${notification.method}`);
        }
    }

    /**
     * Registers a handler for a specific notification method.
     * 
     * @param method - The notification method name
     * @param handler - Callback function to handle the notification
     */
    public onNotification(method: string, handler: (params: any) => void): void {
        this.notificationHandlers.set(method, handler);
    }

    /**
     * Removes a notification handler.
     * 
     * @param method - The notification method name
     */
    public offNotification(method: string): void {
        this.notificationHandlers.delete(method);
    }

    /**
     * Sends a JSON-RPC request and returns a Promise that resolves when the response is received.
     *
     * @param method - The JSON-RPC method name
     * @param params - Optional parameters for the request
     * @param timeoutMs - Request timeout in milliseconds (default: 30s, use 0 to disable)
     * @returns Promise that resolves with the response result
     */
    public async sendRequest(method: string, params?: any, timeoutMs = 30000): Promise<any> {
        if (this.isShutdown) {
            throw new Error('Client is shutdown');
        }

        const id = ++this.requestId;
        const request: JsonRpcRequest = {
            jsonrpc: '2.0',
            id: id,
            method: method,
            params: params
        };

        return new Promise<any>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;

            const cleanup = () => {
                if (timer) { clearTimeout(timer); }
                this.pendingRequests.delete(id);
            };

            this.pendingRequests.set(id, {
                resolve: (value: any) => { cleanup(); resolve(value); },
                reject: (err: Error) => { cleanup(); reject(err); }
            });

            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    if (this.pendingRequests.has(id)) {
                        this.pendingRequests.delete(id);
                        reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms`));
                    }
                }, timeoutMs);
            }

            const requestLine = JSON.stringify(request) + '\n';

            if (!this.process.stdin || this.process.stdin.destroyed) {
                cleanup();
                reject(new Error('Process stdin is not available'));
                return;
            }

            this.process.stdin.write(requestLine, (error) => {
                if (error) {
                    cleanup();
                    reject(error);
                }
            });
        });
    }

    /**
     * Sends a lightweight ping to check if the server is responsive.
     * Returns true if the server responds within the timeout, false otherwise.
     */
    public async ping(timeoutMs = 5000): Promise<boolean> {
        try {
            await this.sendRequest('ping', {}, timeoutMs);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Shuts down the client and cleans up resources.
     */
    private shutdown(error: Error | null): void {
        if (this.isShutdown) {
            return;
        }
        this.isShutdown = true;

        // Reject all pending requests
        const errorToUse = error || new Error('Client shutdown');
        for (const pending of this.pendingRequests.values()) {
            pending.reject(errorToUse);
        }
        this.pendingRequests.clear();
        this.notificationHandlers.clear();

        this.rl.close();
    }

    /**
     * Disposes of the client and terminates the Rust process.
     */
    public dispose(): void {
        this.shutdown(null);
        if (this.process.stdin && !this.process.stdin.destroyed) {
            this.process.stdin.end();
        }
        if (!this.process.killed) {
            this.process.kill();
        }
    }

    /**
     * Checks if the client is shutdown.
     */
    public get isDisposed(): boolean {
        return this.isShutdown;
    }

    /** PID for diagnostics; undefined when spawning failed. */
    public get processId(): number | undefined {
        return this.process.pid;
    }
}
