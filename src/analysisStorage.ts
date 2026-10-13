/** Host launch policy only; indexing and resource ownership remain in Rust. */
export interface AnalysisStorageOptions {
    mode: 'memory' | 'disk';
    edgeBufferMiB: number;
}

export function analysisStorageOptions(mode: unknown, buffer: unknown): AnalysisStorageOptions {
    return {
        mode: mode === 'disk' ? 'disk' : 'memory',
        edgeBufferMiB: typeof buffer === 'number' && Number.isInteger(buffer) && buffer >= 1 && buffer <= 1024 ? buffer : 64
    };
}

export function analysisStorageArguments(options: AnalysisStorageOptions): string[] {
    const safe = analysisStorageOptions(options.mode, options.edgeBufferMiB);
    return ['--storage', safe.mode, '--edge-buffer-mib', String(safe.edgeBufferMiB)];
}

export function analysisStorageReport(value: unknown): { mode: 'memory' | 'disk'; cache_status: 'disabled' | 'built' | 'reused' } | undefined {
    if (!value || typeof value !== 'object') { return undefined; }
    const report = value as Record<string, unknown>;
    if (report.mode === 'memory' && report.cache_status === 'disabled') {
        return { mode: 'memory', cache_status: 'disabled' };
    }
    if (report.mode === 'disk' && (report.cache_status === 'built' || report.cache_status === 'reused')) {
        return { mode: 'disk', cache_status: report.cache_status };
    }
    return undefined;
}
