// Optional local browser checks; run npm run compile first. No heap or network
// service is used. Requires an existing Playwright + Chromium installation.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.HEAPLENS_PLAYWRIGHT_MODULE || 'playwright');
const { getRegistryJs } = require('../out/webview/js/registry');
const { getHelperJs } = require('../out/webview/js/helpers');
const { getHistogramJs } = require('../out/webview/js/histogram');
const { getHtmlTemplate } = require('../out/webview/template');
const { getStyles } = require('../out/webview/styles');
const html = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-histogram-test'; style-src 'unsafe-inline'">
<style>:root { --vscode-foreground:#202124; --vscode-editor-background:#fff;
--vscode-font-family:system-ui; --vscode-font-size:13px; --vscode-editorWidget-background:#eee;
--vscode-input-background:#fff; --vscode-input-foreground:#222; --vscode-input-border:#888;
--vscode-panel-border:#ccc; --vscode-button-background:#176ac5; --vscode-button-foreground:#fff; }
${getStyles()}</style></head><body>${getHtmlTemplate()}
<script nonce="histogram-test">var analysisData = null;
const vscode = {postMessage: message => { window.sentMessages.push(message); }};
window.sentMessages = [];
${getRegistryJs()}${getHelperJs()}${getHistogramJs()}
onMessage('analysisComplete', msg => { analysisData = msg; });
</script></body></html>`;
const data = { command: 'analysisComplete', summary: { reachable_heap_size: 100, total_heap_size: 400 },
  classHistogram: [
    { class_name: 'example.Owner', instance_count: 2, shallow_size: 32, retained_size: 50 },
    { class_name: 'example.Array', instance_count: 1, shallow_size: 75, retained_size: 75 },
    { class_name: 'example.Container', instance_count: 3, shallow_size: 48, retained_size: 75 }
  ] };
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
async function send(page, message) {
  await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
}
for (const width of [1280, 600]) {
  test('Histogram percentages, sorting/filtering and CSV in Chromium at ' + width + 'px', async () => {
    const page = await browser.newPage({ viewport: { width, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.setContent(html);
      await page.locator('#tabBtn-histogram').click();
      await send(page, data);
      assert.deepEqual(await page.locator('#histogram-table tbody td:last-child').allTextContents(), ['75.0%', '75.0%', '50.0%']);
      assert.match(await page.locator('th[data-sort="heap_pct"]').getAttribute('title'), /reachable heap/);
      await page.locator('th[data-sort="heap_pct"]').click();
      await page.locator('th[data-sort="heap_pct"]').click();
      assert.deepEqual(await page.locator('#histogram-table tbody td:last-child').allTextContents(), ['50.0%', '75.0%', '75.0%']);
      await page.locator('#histogram-search').fill('Owner');
      assert.equal(await page.locator('#histogram-table tbody td:last-child').textContent(), '50.0%');
      await page.locator('#export-csv-btn').click();
      const csv = await page.evaluate(() => window.sentMessages.at(-1));
      assert.equal(csv.command, 'exportHistogramCsv');
      assert.match(csv.csv, /"example.Owner",2,32,50,50\.0\n$/);
      await page.locator('#histogram-search').fill('');
      assert.equal(await page.locator('#histogram-table tbody tr').count(), 3);
      assert.match(await page.locator('.histogram-percentage-note').textContent(), /need not sum to 100%/);
      if (process.env.HEAPLENS_HISTOGRAM_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.HEAPLENS_HISTOGRAM_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.HEAPLENS_HISTOGRAM_EVIDENCE_DIR, 'histogram-percentage-' + width + '.png') });
      }
      // Fresh page: missing/zero denominator must never fall back to total heap.
      // setContent alone retains global lexical bindings; navigate to get a
      // genuinely fresh document rather than redeclaring the bridge constant.
      await page.goto('about:blank');
      await page.setContent(html); await page.locator('#tabBtn-histogram').click();
      await send(page, { ...data, summary: { reachable_heap_size: 0, total_heap_size: 400 } });
      assert.deepEqual(await page.locator('#histogram-table tbody td:last-child').allTextContents(), ['N/A', 'N/A', 'N/A']);
      await page.locator('#export-csv-btn').click();
      assert.match(await page.evaluate(() => window.sentMessages.at(-1).csv), /,50,N\/A\n/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
