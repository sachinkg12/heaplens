// Optional real-browser regression: requires an existing Playwright/Chromium
// installation. Default Gradle/CI checks do not claim to execute this suite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.HEAPLENS_PLAYWRIGHT_MODULE || 'playwright');
const html = fs.readFileSync(path.join(__dirname, '../build/generated/webview/webview/index.html'), 'utf8')
  .replaceAll('__NONCE__', 'local-layout-test')
  .replace('__BRIDGE__', 'window.sentMessages = (window.sentMessages || []).concat([message]);');
const evidenceDir = process.env.HEAPLENS_LAYOUT_EVIDENCE_DIR;
const data = {
  command: 'analysisComplete',
  summary: { total_heap_size: 1234567, reachable_heap_size: 1200000, total_instances: 19047,
    total_classes: 1052, total_arrays: 11900, total_gc_roots: 996 },
  topObjects: Array.from({ length: 10 }, (_, i) => ({ object_id: i + 1,
    class_name: 'example.LayoutFixture' + i, node_type: 'Instance', shallow_size: 24,
    retained_size: 10000 - i * 600 })),
  classHistogram: [], leakSuspects: []
};
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function paint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

for (const [width, fontSize] of [[1280, 13], [600, 13], [600, 22]]) {
  test(`scroll headers meet without a gap or tab overlap (${width}px, ${fontSize}px text)`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.setContent(html);
      await page.addStyleTag({ content: `.tab-btn { font-size: ${fontSize}px; }` });
      await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
      await page.locator('#top-objects-table tbody tr').last().waitFor();
      // Exercise the current scroll owner, so the old document-scrolling page
      // fails on actual geometry rather than merely lacking the new CSS rule.
      await page.evaluate(() => {
        const panel = document.getElementById('tab-overview');
        const ownScroll = ['auto', 'scroll'].includes(getComputedStyle(panel).overflowY);
        const owner = ownScroll ? panel : document.scrollingElement;
        const origin = ownScroll ? panel.getBoundingClientRect().top : 0;
        owner.scrollTop += document.querySelector('#top-objects-table').getBoundingClientRect().top - origin + 80;
      });
      await paint(page);
      const metrics = await page.evaluate(() => {
        const tab = document.querySelector('.tab-bar');
        const header = document.querySelector('#top-objects-table th');
        const panel = document.getElementById('tab-overview');
        return { tabTop: tab.getBoundingClientRect().top, tabBottom: tab.getBoundingClientRect().bottom,
          headerTop: header.getBoundingClientRect().top, windowScroll: window.scrollY, panelScroll: panel.scrollTop,
          tabBackground: getComputedStyle(tab).backgroundColor, headerBackground: getComputedStyle(header).backgroundColor };
      });
      if (evidenceDir) {
        fs.mkdirSync(evidenceDir, { recursive: true });
        const stem = path.join(evidenceDir, `scroll-${width}-${fontSize}`);
        await page.screenshot({ path: stem + '.png' });
        fs.writeFileSync(stem + '.json', JSON.stringify(metrics, null, 2) + '\n');
      }
      assert.ok(Math.abs(metrics.headerTop - metrics.tabBottom) <= 1,
        `Headers must meet, not just avoid overlap: tab bottom=${metrics.tabBottom}, table top=${metrics.headerTop}`);
      assert.equal(metrics.tabTop, 0);
      assert.equal(metrics.windowScroll, 0, 'Only the content pane should scroll');
      assert.ok(metrics.panelScroll > 0);
      for (const color of [metrics.tabBackground, metrics.headerBackground]) assert.match(color, /^rgb\(/);
      await page.locator('#top-objects-table th').nth(1).hover();
      assert.match(await page.locator('#top-objects-table th').nth(1).evaluate(el => getComputedStyle(el).backgroundColor), /^rgb\(/);

      // At the table's end the header must leave with the table, not cover the
      // chart. Content is clipped below the navigation even while this happens.
      await page.evaluate(() => { const panel = document.getElementById('tab-overview'); panel.scrollTop = panel.scrollHeight; });
      await paint(page);
      assert.equal(await page.evaluate(() => Boolean(document.elementFromPoint(30, 15)?.closest('.tab-bar'))), true);
      assert.equal(await page.locator('#top-objects-table th').first().evaluate(el => {
        const panel = document.getElementById('tab-overview');
        return el.getBoundingClientRect().bottom <= panel.getBoundingClientRect().top;
      }), true, 'Table header must not float over the charts');

      await page.locator('#tabBtn-query').click();
      await page.locator('#query-input').fill('SELECT class_name FROM instances LIMIT 1');
      await page.locator('#query-run-btn').click();
      assert.equal(await page.evaluate(() => window.sentMessages.at(-1).command), 'executeQuery');
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        command: 'queryResult', query: 'SELECT class_name FROM instances LIMIT 1',
        result: { columns: ['class_name'], rows: Array.from({ length: 60 }, (_, i) => ['example.QueryRow' + i]), total_matched: 60 }
      } })));
      await page.evaluate(() => { const panel = document.getElementById('tab-query'); panel.scrollTop = panel.scrollHeight; });
      assert.ok(await page.locator('#tab-query').evaluate(el => el.scrollTop > 0), 'Query results remain scrollable');
      assert.equal(await page.evaluate(() => window.scrollY), 0);
      await page.locator('#tabBtn-overview').click();
      await page.locator('#tabBtn-query').click();
      assert.equal(await page.locator('#query-input').inputValue(), 'SELECT class_name FROM instances LIMIT 1');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
