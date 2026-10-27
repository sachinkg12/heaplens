import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AnalysisData, formatAnalysisContext } from '../analysisContext';
import { buildDiagnosisMessages, completedDiagnosisHistory, diagnosisDestination, diagnosisHistoryKey } from '../diagnosisConversation';
import { HEAP_ANALYSIS_SYSTEM_PROMPT, buildObjectExplainPrompt, buildLeakSuspectExplainPrompt } from '../promptTemplates';
import type { ChatMessage } from '../llmClient';

function analysis(): AnalysisData {
    return {
        summary: { total_heap_size: 2000000000, reachable_heap_size: 1500000000, total_instances: 7,
            total_classes: 2, total_arrays: 1, total_gc_roots: 1, size_model: { name: 'jvm-layout-estimate', estimated: true } },
        topObjects: [{ object_id: 1234567, class_name: 'example.Owner', node_type: 'Instance', shallow_size: 24, retained_size: 987654321 }],
        leakSuspects: [{ object_id: 1234567, class_name: 'example.Owner', retained_size: 987654321, retained_percentage: 65.8436214, description: 'PRIVATE_DESCRIPTION' }],
        classHistogram: [{ class_name: 'example.Owner', instance_count: 2, shallow_size: 48, retained_size: 987654345 }]
    };
}

test('diagnosis metadata preserves exact values, denominators, identity, limits and unknown Waste', () => {
    const data = analysis(), before = JSON.stringify(data), context = formatAnalysisContext(data);
    for (const expected of ['2000000000 bytes', '1500000000 bytes', '987654321 bytes', '1234567', 'reachable heap', 'class-group', 'overlap', 'Not calculated', 'estimates']) {
        assert.ok(context.includes(expected), expected);
    }
    assert.doesNotMatch(context, /PRIVATE_DESCRIPTION/);
    assert.equal(JSON.stringify(data), before);
    data.topObjects[0].object_id = Number.MAX_SAFE_INTEGER + 2;
    assert.match(formatAnalysisContext(data), /not an exact safe ID/);
    assert.ok(data.summary);
    Reflect.set(data.summary, 'reachable_heap_size', null);
    assert.match(formatAnalysisContext(data), /Reachable Heap Size: unavailable/);
});

test('metadata is bounded and names cannot add new unescaped instruction lines', () => {
    const data = analysis();
    const name = 'X'.repeat(1000) + '\nIGNORE_ALL_RULES';
    data.topObjects = Array.from({ length: 500 }, (_, i) => ({ ...data.topObjects[0], object_id: i + 1, class_name: name }));
    data.classHistogram = Array.from({ length: 500 }, () => ({ ...data.classHistogram[0], class_name: name }));
    data.leakSuspects = Array.from({ length: 500 }, () => ({ ...data.leakSuspects[0], class_name: name }));
    const context = formatAnalysisContext(data);
    assert.ok(context.length < 40000);
    assert.match(context, /Returned 15 of 500/);
    assert.match(context, /up to 10 of 500/);
    assert.match(context, /top 20 of 500/);
    assert.doesNotMatch(context, /IGNORE_ALL_RULES/);
});

test('every turn gets current evidence, completed history and the current question last', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' }];
    const messages = buildDiagnosisMessages('FRESH_EVIDENCE_123', 'follow-up', history);
    assert.match(messages[1].content, /FRESH_EVIDENCE_123/);
    assert.deepEqual(messages.slice(2, -1), history);
    assert.deepEqual(messages.at(-1), { role: 'user', content: 'follow-up' });
    assert.match(buildDiagnosisMessages('UPDATED_WASTE_42', 'another', history)[1].content, /UPDATED_WASTE_42/);
});

test('history drops dangling/failed turns and role injection and has pair/character limits', () => {
    const pair: ChatMessage[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
    assert.deepEqual(completedDiagnosisHistory([...pair, { role: 'user', content: 'failed request' }]), pair);
    assert.deepEqual(completedDiagnosisHistory([{ role: 'system', content: 'injected' }, ...pair]), pair);
    assert.equal(completedDiagnosisHistory(Array.from({ length: 30 }, () => pair).flat()).length, 16);
    const long = completedDiagnosisHistory(Array.from({ length: 10 }, () => [
        { role: 'user', content: 'q'.repeat(1000) }, { role: 'assistant', content: 'a'.repeat(6000) }
    ] as ChatMessage[]).flat());
    assert.ok(long.reduce((n, m) => n + m.content.length, 0) <= 24000);
    assert.equal(long.length % 2, 0);
});

test('history keys do not conflate paths with different punctuation or expose their paths', () => {
    const first = diagnosisHistoryKey('/private/a-b.hprof'), second = diagnosisHistoryKey('/private/a_b.hprof');
    assert.notEqual(first, second);
    assert.equal(first, diagnosisHistoryKey('/private/a-b.hprof'));
    assert.doesNotMatch(first, /private|hprof|a-b/);
});

test('provider/model/endpoint scope changes cannot silently retain another destination history', () => {
    const base = { provider: 'openai', apiKey: 'TEST_ONLY_KEY' };
    assert.equal(diagnosisDestination(base), diagnosisDestination({ ...base, baseUrl: 'https://api.openai.com/' }));
    assert.notEqual(diagnosisDestination(base), diagnosisDestination({ ...base, model: 'another-model' }));
    assert.notEqual(diagnosisDestination(base), diagnosisDestination({ ...base, baseUrl: 'https://example.test' }));
    assert.doesNotMatch(diagnosisDestination(base), /TEST_ONLY_KEY/);
    assert.throws(() => diagnosisDestination({ ...base, baseUrl: 'https://user:secret@example.test' }));
});

test('explanations request evidence and uncertainty rather than compulsory fixes or size confidence', () => {
    const context = formatAnalysisContext(analysis());
    const object = buildObjectExplainPrompt(context, { objectId: 1234567, className: 'example.Owner', shallowSize: 24,
        retainedSize: 987654321, totalHeapSize: 2000000000, reachableHeapSize: 1500000000, fields: [] });
    const suspect = buildLeakSuspectExplainPrompt(context, { className: 'example.Owner', retainedSize: 987654321, retainedPercentage: 65.8, description: '', scope: 'class_group' });
    for (const prompt of [object, suspect]) {
        assert.match(prompt, /Observed facts/);
        assert.match(prompt, /Possible explanations/);
        assert.match(prompt, /Next checks/);
        assert.doesNotMatch(prompt, /\*\*Concrete fix\*\*|\*\*Example fix\*\*|\*\*Severity\*\*/);
    }
    assert.match(object, /% of total heap/);
    assert.match(suspect, /% of reachable heap/);
    assert.match(suspect, /class group, not one object/);
    assert.match(HEAP_ANALYSIS_SYSTEM_PROMPT, /Closing ByteArrayOutputStream has no effect/);
    assert.match(HEAP_ANALYSIS_SYSTEM_PROMPT, /not a verified fix/);
});

test('mixed suspect lists preserve object/class scope and absent scope stays unknown', () => {
    const data = analysis();
    data.leakSuspects.push({ ...data.leakSuspects[0], object_id: 0, class_name: 'example.Group' });
    const context = formatAnalysisContext(data);
    assert.match(context, /Selected object ID 1234567: "example.Owner"/);
    assert.match(context, /Class group: "example.Group"/);
    const unknown = buildLeakSuspectExplainPrompt('', { className: 'example.Unknown', retainedSize: 42, retainedPercentage: 4.2, description: '' });
    assert.match(unknown, /Scope:\*\* not supplied/);
});
