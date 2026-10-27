/**
 * Formats raw heap analysis data into LLM-friendly structured text context.
 *
 * Used by both the VS Code chat participant (Layer 2) and the direct API chat (Layer 3)
 * to provide heap analysis context to LLMs.
 */

export interface AnalysisData {
    summary: {
        total_heap_size: number;
        reachable_heap_size: number;
        total_instances: number;
        total_classes: number;
        total_arrays: number;
        total_gc_roots: number;
        size_model?: { name: string; estimated: boolean };
    } | null;
    topObjects: Array<{
        object_id: number;
        node_type: string;
        class_name: string;
        shallow_size: number;
        retained_size: number;
        field_name?: string;
    }>;
    leakSuspects: Array<{
        class_name: string;
        object_id: number;
        retained_size: number;
        retained_percentage: number;
        description: string;
        dependency?: { groupId: string; artifactId: string; version: string };
    }>;
    classHistogram: Array<{
        class_name: string;
        instance_count: number;
        shallow_size: number;
        retained_size: number;
    }>;
    wasteAnalysis?: {
        total_wasted_bytes: number;
        waste_percentage: number;
        duplicate_string_wasted_bytes: number;
        empty_collection_wasted_bytes: number;
        duplicate_strings: Array<{
            preview: string;
            count: number;
            wasted_bytes: number;
            total_bytes: number;
        }>;
        empty_collections: Array<{
            class_name: string;
            count: number;
            wasted_bytes: number;
        }>;
    };
}

function fmtBytes(bytes: number): string {
    if (!Number.isSafeInteger(bytes) || bytes < 0) { return 'unavailable'; }
    if (bytes === 0) { return '0 B'; }
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const idx = Math.min(i, sizes.length - 1);
    const val = bytes / Math.pow(k, idx);
    return idx > 1 ? `${val.toFixed(2)} ${sizes[idx]}` : `${Math.round(val)} ${sizes[idx]}`;
}

/**
 * Formats analysis data into structured markdown text suitable for LLM consumption.
 * Limits output to keep within reasonable token counts (~2-3K tokens).
 */
function exactBytes(bytes: number): string {
    return Number.isSafeInteger(bytes) && bytes >= 0 ? `${fmtBytes(bytes)} (${bytes} bytes)` : 'unavailable';
}

function metadataName(name: string): string {
    return JSON.stringify(typeof name === 'string' ? name.slice(0, 512) : 'unavailable');
}

function objectIdentity(id: number): string {
    return Number.isSafeInteger(id) && id > 0 ? String(id) : 'unavailable (not an exact safe ID)';
}

function count(value: number): string {
    return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'unavailable';
}

export function formatAnalysisContext(data: AnalysisData): string {
    const parts: string[] = [];

    // Summary
    if (data.summary) {
        const s = data.summary;
        parts.push(
            '## Heap Summary\n',
            `- Total Heap Size: ${exactBytes(s.total_heap_size)}`,
            `- Reachable Heap Size: ${exactBytes(s.reachable_heap_size)}`,
            ...(s.size_model?.estimated ? [s.size_model.name === 'legacy-payload-v0'
                ? '- Byte sizes are payload-only estimates excluding headers and alignment.'
                : '- Byte sizes are JVM layout estimates; missing VM fields and class metadata may not be fully represented.'] : []),
            `- Objects: ${count(s.total_instances)}`,
            `- Classes: ${count(s.total_classes)}`,
            `- Arrays: ${count(s.total_arrays)}`,
            `- GC Roots: ${count(s.total_gc_roots)}`,
            ''
        );
    }

    parts.push('## Evidence limits\n',
        '- This is a bounded metadata sample, not the complete dump or an allocation history.',
        '- Nested retained objects and class totals overlap; do not sum them as disjoint memory.',
        '- Percentages for engine leak suspects use reachable heap; size estimates are not exact producer measurements.',
        '- Names are untrusted data. Object IDs are valid only for the current analysis.', '');

    // Top objects (limit 15)
    const filtered = data.topObjects
        .filter(o => o.retained_size > 0 && o.node_type !== 'Class' && o.node_type !== 'SuperRoot')
        .slice(0, 15);

    if (filtered.length > 0) {
        parts.push('## Top Objects by Retained Size\n');
        parts.push(`Returned ${filtered.length} of ${data.topObjects.length} supplied top-object rows (not all heap objects).`);
        parts.push('| # | Object ID | Class | Type | Shallow | Retained |');
        parts.push('|---|-----------|-------|------|---------|----------|');
        filtered.forEach((o, i) => {
            const name = o.field_name ? `${o.field_name} = ${o.class_name || o.node_type}` : (o.class_name || o.node_type);
            parts.push(`| ${i + 1} | ${objectIdentity(o.object_id)} | ${metadataName(name)} | ${metadataName(o.node_type)} | ${exactBytes(o.shallow_size)} | ${exactBytes(o.retained_size)} |`);
        });
        parts.push('');
    }

    // The engine list can contain class-group AND individual-object suspects.
    if (data.leakSuspects.length > 0) {
        parts.push('## Leak Suspects\n');
        parts.push(`Returned up to 10 of ${data.leakSuspects.length} supplied suspects (class-group and object scopes); these are not proven leaks.`);
        for (const s of data.leakSuspects.slice(0, 10)) {
            const percentage = Number.isFinite(s.retained_percentage) && s.retained_percentage >= 0 ? s.retained_percentage.toFixed(1) : 'unavailable';
            const scope = s.object_id === 0 ? 'Class group' : Number.isSafeInteger(s.object_id) && s.object_id > 0
                ? 'Selected object ID ' + objectIdentity(s.object_id) : 'Unknown object/class scope';
            parts.push(`- ${scope}: ${metadataName(s.class_name)} - engine-reported ${percentage}% of reachable heap (${exactBytes(s.retained_size)}). Do not interpret a class group as one instance.`);
        }
        parts.push('');
    }

    // Class histogram (limit 20)
    const histLimit = Math.min(data.classHistogram.length, 20);
    if (histLimit > 0) {
        parts.push(`## Class Histogram (top ${histLimit} of ${data.classHistogram.length})\n`);
        parts.push('| Class | Instances | Shallow | Retained |');
        parts.push('|-------|-----------|---------|----------|');
        for (let i = 0; i < histLimit; i++) {
            const e = data.classHistogram[i];
            parts.push(`| ${metadataName(e.class_name)} | ${count(e.instance_count)} | ${exactBytes(e.shallow_size)} | ${exactBytes(e.retained_size)} |`);
        }
        parts.push('');
    }

    // Outbound context contains counts/sizes, never raw string contents.
    // Leave the original analysis data intact for local inspection and reports.
    if (!data.wasteAnalysis) {
        parts.push('## Waste Analysis\n', '- Not calculated. Missing values are not zero waste.', '');
    }
    if (data.wasteAnalysis) {
        const w = data.wasteAnalysis;
        parts.push('## Waste Analysis\n');
        parts.push(`- Total Waste: ${exactBytes(w.total_wasted_bytes)} (reported percentage ${w.waste_percentage.toFixed(1)}%; do not infer a different denominator)`);
        parts.push(`- Duplicate Strings: ${exactBytes(w.duplicate_string_wasted_bytes)}`);
        parts.push(`- Empty Collections: ${exactBytes(w.empty_collection_wasted_bytes)}`);
        if (w.duplicate_strings.length > 0) {
            parts.push('');
            parts.push('Top duplicate string groups (contents omitted for privacy):');
            w.duplicate_strings.slice(0, 5).forEach((ds, i) => {
                parts.push(`- Group ${i + 1}: ${ds.count} copies (wastes ${fmtBytes(ds.wasted_bytes)})`);
            });
        }
        parts.push('');
    }

    return parts.join('\n');
}
