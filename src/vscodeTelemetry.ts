import * as https from 'https';
import { randomBytes } from 'crypto';
import type { TelemetryReporter, CustomFetcher } from '@vscode/extension-telemetry';
// The shared implementation is unchanged: it remains the identity-free error path.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Telemetry } = require('../telemetry/node.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { schema, record, platform, architecture } = require('../telemetry/contract.cjs');

export type TelemetryLevel = 'off' | 'error' | 'all';

/** VS Code only. The SDK supplies its usual VS Code machine/session IDs for usage. */
export class VSCodeTelemetry {
    private readonly diagnostics: InstanceType<typeof Telemetry>;
    private readonly context: {host: string; version: string; os: string; arch: string};
    private sdk: TelemetryReporter | null = null;
    private level: TelemetryLevel = 'off';
    private generation = 0;
    private closed = false;
    private usageSubmitted = 0;
    private sdkUnavailable = false;
    private shutdown: Promise<void> | null = null;
    private readonly requests = new Set<() => void>();

    constructor(version: string, private readonly permission: () => TelemetryLevel) {
        this.context = { host: 'vscode', version, os: platform(process.platform), arch: architecture(process.arch) };
        this.diagnostics = new Telemetry({ context: this.context });
    }

    setLevel(level: TelemetryLevel): void {
        if (this.closed || level === this.level) { return; }
        this.level = level;
        // Usage must not also travel through the shared identity-free transport.
        this.diagnostics.setLevel(level === 'all' ? 'error' : level);
        if (level !== 'all') { void this.retireSdk(true); return; }
        const generation = this.generation;
        try {
            // Load/initialize no SDK when the editor, application or environment disallows usage.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { TelemetryReporter: Reporter } = require('@vscode/extension-telemetry');
            const token = randomBytes(16).toString('hex');
            const keys = ['schemaVersion', 'host', 'version', 'os', 'arch', '__heaplens_delivery', ...Object.keys(schema.enums)];
            const allowed = keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
            this.sdk = new Reporter('InstrumentationKey=' + schema.instrumentationKey +
                ';IngestionEndpoint=' + schema.endpoint.replace(/\/v2\/track$/, '/'),
                [{ lookup: new RegExp('^(?!(?:' + allowed + ')$)') }],
                { ignoreBuiltInCommonProperties: true, ignoreUnhandledErrors: true },
                this.fetcher(generation, token), { endpointUrl: schema.endpoint, commonProperties: { __heaplens_delivery: token } });
            this.sdkUnavailable = false;
        } catch { this.sdkUnavailable = true; }
    }

    track(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
        if (this.closed) { return; }
        try {
            this.setLevel(this.permission());
            const event = record(name, this.context, properties, measurements);
            if (!event) { return; }
            this.diagnostics.track(name, properties, measurements);
            if (event.category !== 'usage' || this.level !== 'all' || this.permission() !== 'all' ||
                !this.sdk || this.usageSubmitted >= 256) { return; }
            this.sdk.sendTelemetryEvent(name, event.properties, event.measurements);
            this.usageSubmitted++;
        } catch { /* Diagnostics must never interrupt heap analysis. */ }
    }

    report(): unknown {
        return { ...this.diagnostics.report(), level: this.level, usageSubmitted: this.usageSubmitted,
            sdkUnavailable: this.sdkUnavailable,
            note: 'Filtered custom fields below. VS Code usage also carries SDK machine/session IDs for counts; errors remain identity-free. Submission is not proof of Azure receipt. IDs are pseudonymous, not people. Network services may process IP addresses.' };
    }

    private async retireSdk(withdrawn: boolean): Promise<void> {
        const sdk = this.sdk; this.sdk = null;
        if (withdrawn) {
            this.generation++;
            for (const abort of this.requests) { abort(); }
        }
        // The pinned SDK initializes its client on a microtask; let that finish
        // before disposal so immediate opt-out cannot strand its pending client.
        try { if (sdk) { await new Promise<void>(resolve => setImmediate(resolve)); await sdk.dispose(); } }
        catch { /* No failure may escape into the editor. */ }
    }

    /** The SDK buffers/retries: application permission must also hold at physical delivery. */
    private fetcher(generation: number, token: string): CustomFetcher {
        return async (url, init) => {
            const dropped = { status: 200, headers: [] as Array<[string, string]>, text: async () => '' };
            if (generation !== this.generation || this.level !== 'all' || this.permission() !== 'all' ||
                url !== schema.endpoint || init?.method !== 'POST' || !init.body ||
                Buffer.byteLength(init.body) > 1024 * 1024) { return dropped; }
            // Some Node versions expose sessionStorage, which the SDK may use
            // to restore old buffers. Never deliver another permission generation.
            // This process-local guard is removed before transmission; it is not a counting ID.
            let body: string;
            try {
                const packets = JSON.parse(init.body);
                if (!Array.isArray(packets)) { return dropped; }
                const current = packets.filter(packet => packet?.data?.baseData?.properties?.__heaplens_delivery === token);
                if (!current.length) { return dropped; }
                for (const packet of current) { delete packet.data.baseData.properties.__heaplens_delivery; }
                body = JSON.stringify(current);
            } catch { return dropped; }
            return new Promise((resolve, reject) => {
                let finished = false;
                const finish = (error?: Error, response = dropped) => {
                    if (finished) { return; } finished = true;
                    clearTimeout(deadline); this.requests.delete(abort);
                    if (error) { reject(error); } else { resolve(response); }
                };
                const request = https.request(schema.endpoint, { method: 'POST', headers: {
                    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
                } }, response => {
                    let responseBody = '';
                    response.on('data', chunk => {
                        responseBody += chunk.toString();
                        if (responseBody.length > 65536) { request.destroy(new Error('Telemetry response limit')); }
                    });
                    response.on('error', () => finish(new Error('Telemetry response unavailable')));
                    response.on('end', () => finish(undefined, { status: response.statusCode || 0,
                        headers: [], text: async () => responseBody }));
                });
                const abort = () => { finish(); request.destroy(); };
                this.requests.add(abort);
                request.on('error', () => finish(new Error('Telemetry delivery unavailable')));
                const deadline = setTimeout(() => { request.destroy(); finish(new Error('Telemetry deadline')); }, 1000);
                deadline.unref(); request.end(body);
            });
        };
    }

    dispose(): Promise<void> {
        if (this.shutdown) { return this.shutdown; } this.closed = true;
        this.shutdown = (async () => {
            this.diagnostics.dispose();
            // Normal shutdown may flush permitted usage. Withdrawal retires before flushing instead.
            await this.retireSdk(false);
            this.level = 'off'; this.generation++;
            for (const abort of this.requests) { abort(); }
        })();
        return this.shutdown;
    }
}
