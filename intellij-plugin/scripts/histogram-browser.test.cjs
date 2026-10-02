// Optional Chromium smoke test, not a native JCEF or real-engine test.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.HEAPLENS_PLAYWRIGHT_MODULE || 'playwright');
const html = fs.readFileSync(path.join(__dirname, '../build/generated/webview/webview/index.html'), 'utf8')
  .replaceAll('__NONCE__', 'local-histogram-test')
  .replace('__BRIDGE__', 'window.sentMessages = (window.sentMessages || []).concat([message]);');
const data = {
  command: 'analysisComplete', summary: { total_heap_size: 200000, reachable_heap_size: 180000,
    total_instances: 500, total_classes: 205, total_arrays: 40, total_gc_roots: 4 },
  topObjects: [], leakSuspects: [],
  classHistogram: Array.from({ length: 205 }, (_, i) => ({ class_name: 'example.Class' + i,
    instance_count: i + 1, shallow_size: (i + 1) * 24, retained_size: (i + 1) * 40 }))
};
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
async function send(page, data) {
  await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
}
async function latest(page) { return page.evaluate(() => window.sentMessages.at(-1)); }
function result(request) {
  return { ...request, command: 'histogramInstancesResult', result: {
    columns: ['object_id', 'node_type', 'class_name', 'shallow_size', 'retained_size'],
    rows: [[7, 'Instance', request.className, 24, 80]], total_count: 1, execution_time_ms: 1
  } };
}
for (const width of [1280, 600]) {
  test('Histogram filter, sort, drill-down, isolation and recovery (' + width + 'px)', async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.setContent(html);
      await send(page, data);
      await page.locator('#tabBtn-query').click();
      await page.locator('#query-input').fill('SELECT class_name FROM instances LIMIT 1');
      await page.locator('#query-run-btn').click();
      const query = await latest(page);
      await send(page, { command: 'queryResult', query: query.query,
        result: { columns: ['class_name'], rows: [['preserved.QueryResult']], total_matched: 1 } });
      const queryHtml = await page.locator('#query-results').innerHTML();
      const history = await page.locator('#query-history').innerHTML();
      await page.locator('#tabBtn-histogram').click();
      assert.equal(await page.locator('#histogram-table tbody tr').count(), 200);
      assert.equal(await page.locator('#histogram-table th:visible').count(), 5);
      assert.equal(await page.locator('#histogram-table tbody tr').first().locator('td').last().textContent(), '4.6%');
      assert.match(await page.locator('th[data-sort="heap_pct"]').getAttribute('title'), /reachable heap/);
      assert.equal(await page.locator('#export-csv-btn').isVisible(), false);
      await page.locator('#show-all-histogram').click();
      assert.equal(await page.locator('#histogram-table tbody tr').count(), 205);
      await page.locator('#tab-histogram').evaluate(el => { el.scrollTop = 500; });
      const bounds = await page.evaluate(() => ({
        tab: document.querySelector('.tab-bar').getBoundingClientRect().bottom,
        header: document.querySelector('#histogram-table th').getBoundingClientRect().top
      }));
      assert.ok(Math.abs(bounds.tab - bounds.header) <= 1, JSON.stringify(bounds));
      await page.locator('#histogram-table th[data-sort="instance_count"]').click();
      assert.equal(await page.locator('.hist-class-link').first().textContent(), 'example.Class204');
      await page.locator('#histogram-table th[data-sort="instance_count"]').click();
      assert.equal(await page.locator('.hist-class-link').first().textContent(), 'example.Class0');
      await page.locator('#histogram-search').fill('CLASS204');
      assert.equal(await page.locator('.hist-class-link').count(), 1);
      assert.equal(await page.locator('#histogram-table tbody td:last-child').textContent(), '4.6%');
      await page.locator('th[data-sort="heap_pct"]').click();
      assert.equal(await page.locator('#histogram-table tbody td:last-child').textContent(), '4.6%');
      await page.locator('.hist-class-link').click();
      const request = await latest(page);
      assert.equal(request.command, 'histogramInstances');
      assert.equal(request.className, 'example.Class204');
      await send(page, result(request));
      assert.equal(await page.locator('#histogram-instances-panel tbody tr').count(), 1);
      assert.equal(await page.locator('#histogram-instances-panel .instance-action:visible').count(), 0);
      assert.match(await page.locator('.histogram-hint').textContent(), /up to 200/);
      assert.equal(await page.locator('#query-results').innerHTML(), queryHtml);
      assert.equal(await page.locator('#query-history').innerHTML(), history);
      assert.equal(await page.locator('#query-input').inputValue(), query.query);
      if (process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR, 'histogram-' + width + '.png') });
      }
      await page.locator('.instance-panel-close').click();
      await send(page, result(request));
      assert.equal(await page.locator('#histogram-instances-panel').textContent(), '');
      await page.locator('.hist-class-link').click();
      const old = await latest(page);
      await send(page, { command: 'serverCrashed' });
      assert.equal(await page.locator('#histogram-search').isDisabled(), true);
      await send(page, result(old));
      assert.equal(await page.locator('#histogram-instances-panel').textContent(), '');
      await send(page, { command: 'analysisProgress', stage: 'loading', phase: 1, totalPhases: 4 });
      await send(page, data);
      assert.equal(await page.locator('#histogram-table tbody td:last-child').textContent(), '4.6%');
      await page.locator('.hist-class-link').click();
      const fresh = await latest(page);
      assert.notEqual(fresh.requestId, old.requestId);
      await send(page, result(old));
      assert.match(await page.locator('#histogram-instances-panel').textContent(), /Loading/);
      await send(page, result(fresh));
      assert.equal(await page.locator('#histogram-instances-panel tbody tr').count(), 1);
      await page.locator('#histogram-search').fill('does not exist');
      assert.equal(await page.locator('.hist-class-link').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
