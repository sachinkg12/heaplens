import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { getDominatorTreeJs } from '../webview/js/dominatorTree';

// Exercise the shipped renderer; DOM geometry is deliberately not simulated.
function harness() {
    const posted: any[] = [], callbacks: Record<string, (value: any) => void> = {};
    function element() {
        const handlers: Record<string, (event: any) => void> = {}, children: any[] = [];
        return { innerHTML: '', style: {} as any, dataset: {} as any, children, handlers,
            classList: { add() { /* No layout in this harness. */ }, remove() { /* No layout. */ } },
        setAttribute() { /* Attribute layout is not simulated. */ },
            addEventListener: (name: string, fn: any) => { handlers[name] = fn; },
            appendChild: (child: any) => children.push(child), querySelector: () => element() };
    }
    const controls = new Map<string, ReturnType<typeof element>>();
    const document = { createElement: () => element(), getElementById: (id: string) => {
        if (!controls.has(id)) { controls.set(id, element()); } return controls.get(id);
    } };
    const context: any = { document, Number, analysisData: null, depInfoCache: {}, isResolvableClass: () => false,
        escapeHtml: (s: string) => s, fmt: String, window: {}, vscode: { postMessage: (m: any) => posted.push(m) },
        onMessage: (name: string, fn: any) => { callbacks[name] = fn; },
        onTabMessage: (_tab: string, name: string, fn: any) => { callbacks[name] = fn; } };
    runInNewContext(getDominatorTreeJs(), context);
    const object = (id: number, retained: number) => ({ object_id: id, class_name: 'Owner', node_type: 'Instance', shallow_size: 24, retained_size: retained });
    const control = (id: string) => { const value = controls.get(id); if (!value) { throw new Error('Missing control'); } return value; };
    return {
        load: (reachable: unknown) => { const data = { summary: { reachable_heap_size: reachable, total_heap_size: 400 },
            topLayers: [object(1, 95), object(2, 95), object(3, 95)] }; callbacks.analysisComplete(data); context.analysisData = data; },
        reset: () => control('reset-tree-btn').handlers.click({}),
        child: (retained: number) => context.createTreeRow(object(4, retained), 1).innerHTML as string,
        notify: (name: string) => callbacks[name]?.({}),
        denominator: () => context._reachableHeap,
        html: () => control('dominator-tree').children.map(row => row.innerHTML).join('') as string
    };
}
test('Dominator Tree uses reachable heap, not overlapping top layers, including children/reset', () => {
    const h = harness(); h.load(100);
    assert.equal((h.html().match(/tree-pct[^>]*>95\.0%/g) || []).length, 3);
    assert.match(h.child(25), /tree-pct[^>]*>25\.0%/); h.reset();
    assert.doesNotMatch(h.html(), /33\.3%/);
});
test('Dominator Tree rejects invalid retained sizes instead of displaying NaN/Infinity', () => {
    const h = harness(); h.load(100);
    for (const retained of [NaN, Infinity, -1]) {
        assert.match(h.child(retained), /tree-pct[^>]*>N\/A/);
        assert.doesNotMatch(h.child(retained), /(?:width:NaN|width:Infinity|>NaN%|>Infinity%)/);
    }
});
test('Dominator denominator is editor-local and retired on restart, failure and cancellation', () => {
    const a = harness(), b = harness(); a.load(100); b.load(200);
    assert.match(a.child(25), /25\.0%/); assert.match(b.child(25), /12\.5%/);
    for (const event of ['analysisStarting', 'analysisCancelled', 'analysisFailed', 'serverCrashed']) {
        a.load(100); a.notify(event); assert.equal(a.denominator(), null, event);
        assert.match(a.child(25), /N\/A/); a.load(250); assert.match(a.child(25), /10\.0%/);
        assert.match(b.child(25), /12\.5%/);
    }
});
test('Dominator Tree does not invent percentages when reachable heap is unavailable', () => {
    for (const value of [undefined, 0, -1, NaN, Infinity, '100']) {
        const h = harness(); h.load(value); assert.match(h.html(), /tree-pct[^>]*>N\/A/);
        assert.doesNotMatch(h.html(), /NaN|Infinity|23\.8%/);
    }
});
