import * as assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { getHistogramJs } from '../webview/js/histogram';
import { getRegistryJs } from '../webview/js/registry';
import { getHelperJs } from '../webview/js/helpers';

export interface Entry { class_name: string; instance_count: number; shallow_size: number; retained_size: number }
export interface Analysis { summary?: { reachable_heap_size?: unknown; total_heap_size?: number }; classHistogram: Entry[] }

// Execute the real registry, helpers and Histogram script. Only DOM operations
// used by these tests are emulated; browser layout/native editor behavior is not.
export function histogramHarness() {
    const posted: any[] = [];
    const listeners: Record<string, (event: any) => void> = {};
    function control(dataset = {}) {
        const handlers: Record<string, (event?: any) => void> = {};
        return { dataset, handlers, value: '', classList: { add() { /* No layout in this harness. */ }, remove() { /* No layout. */ } },
            addEventListener: (event: string, callback: (event?: any) => void) => { handlers[event] = callback; },
            setAttribute() { /* Attribute-dependent behavior is browser-tested separately. */ }, click() { handlers.click?.(); } };
    }
    const search = control(), csv = control(), showAll = control();
    const tabs = [control({ tab: 'overview' }), control({ tab: 'histogram' })];
    let headings: ReturnType<typeof control>[] = [];
    const table = { innerHTML: '', querySelectorAll(selector: string) {
        if (selector !== 'th[data-sort]') return [];
        headings = [...this.innerHTML.matchAll(/data-sort="([^"]+)"/g)].map(m => control({ sort: m[1] }));
        return headings;
    } };
    const document = {
        getElementById(id: string) {
            if (id === 'histogram-table') return table;
            if (id === 'histogram-search') return search;
            if (id === 'export-csv-btn') return csv;
            if (id === 'show-all-histogram') return table.innerHTML.includes('id="show-all-histogram"') ? showAll : null;
            return control();
        },
        querySelectorAll: (selector: string) => selector === '.tab-btn' ? tabs : [],
        querySelector: () => null,
        createElement() {
            return { innerHTML: '', set textContent(value: string) {
                this.innerHTML = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            } };
        }
    };
    runInNewContext('var analysisData = null;\n' + getRegistryJs() + getHelperJs() + getHistogramJs()
        + '\nonMessage("analysisComplete", function(msg) { analysisData = msg; });', {
        document, window: { addEventListener: (event: string, callback: any) => { listeners[event] = callback; } },
        vscode: { postMessage: (message: any) => posted.push(message) }
    });
    return {
        activate: () => tabs[1].click(),
        complete: (data: Analysis) => listeners.message({ data: { command: 'analysisComplete', ...data } }),
        html: () => table.innerHTML,
        rows: () => [...table.innerHTML.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)]
            .flatMap(body => [...body[1].matchAll(/<tr>(.*?)<\/tr>/g)])
            .map(row => [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(cell => cell[1].replace(/<[^>]+>/g, ''))),
        filter(value: string) { search.value = value; search.handlers.input({ target: search }); },
        sort(key: string) {
            const header = headings.find(h => (h.dataset as { sort: string }).sort === key);
            assert.ok(header, 'Sort control missing: ' + key); header.click();
        },
        showAll: () => showAll.click(),
        csv() { csv.click(); const message = posted[posted.length - 1];
            assert.equal(message.command, 'exportHistogramCsv'); return message.csv as string; }
    };
}
