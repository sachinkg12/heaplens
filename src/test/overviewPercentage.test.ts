import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { getOverviewJs } from '../webview/js/overview';

function render(reachable: unknown) {
    const section = { innerHTML: '', addEventListener: () => undefined };
    const context: any = { document: { getElementById: () => section }, onMessage: () => undefined,
        escapeHtml: String, fmtNum: String, fmt: String, setTimeout, clearTimeout };
    runInNewContext(getOverviewJs(), context);
    context.renderDiagnosis({
        summary: { reachable_heap_size: reachable, total_heap_size: 100 },
        classHistogram: [{ class_name: 'example.Cache', retained_size: 50, instance_count: 2 }], leakSuspects: []
    });
    return section.innerHTML;
}
test('Overview Quick Checks never substitute total heap when reachable heap is unavailable', () => {
    for (const reachable of [undefined, 0, -1, NaN, Infinity, '100']) { assert.equal(render(reachable), ''); }
});
test('Overview Quick Checks use reachable heap consistently with Histogram and Dominator Tree', () => {
    assert.match(render(200), /25\.0%/); assert.doesNotMatch(render(200), /50\.0%/);
});
