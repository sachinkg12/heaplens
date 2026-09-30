// Build-time reuse, not a fork: the VS Code sources and build remain unchanged.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../node_modules/typescript');
const root = path.resolve(__dirname, '../..');
function exported(file, name) {
  const source = fs.readFileSync(path.join(root, 'src/webview', file + '.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const context = { exports: {} };
  vm.runInNewContext(output, context, { filename: file, timeout: 5000 });
  return context.exports[name]();
}
const parts = [
  ['registry', 'getRegistryJs'], ['helpers', 'getHelperJs'],
  ['overview', 'getOverviewJs'], ['query', 'getQueryJs'], ['progress', 'getProgressJs']
].map(([file, name]) => exported('js/' + file, name)).join('\n');
const styles = exported('styles', 'getStyles');
const template = exported('template', 'getHtmlTemplate');
const queryLifecycle = fs.readFileSync(path.join(__dirname, '../src/main/webview/query-lifecycle.js'), 'utf8');
const layout = fs.readFileSync(path.join(__dirname, '../src/main/webview/layout.css'), 'utf8');
const histogramStyles = fs.readFileSync(path.join(__dirname, '../src/main/webview/histogram.css'), 'utf8');
const histogramAdapter = fs.readFileSync(path.join(__dirname, '../src/main/webview/histogram-adapter.js'), 'utf8');
// Scope its transport and reply subscription, not its shared rendering logic.
const histogram = '(function(send, listen) {\n' +
  'const vscode = {postMessage: message => requestHistogramInstances(message)};\n' +
  'const onMessage = (command, handler) => {\n' +
  '  if (command === "queryResult") listen("histogramInstancesResult", message => {\n' +
  '    if (acceptHistogramResult(message)) handler(message);\n' +
  '  }); else listen(command, handler);\n' +
  '};\n' +
  exported('js/histogram', 'getHistogramJs') + '\n' + histogramAdapter +
  '\n})(vscode.postMessage, onMessage);\n';
const d3 = fs.readFileSync(path.join(root, 'media/d3.v7.min.js'), 'utf8');
// Preserve DOM dependencies, but expose only implemented capabilities.
const setup = `
document.querySelectorAll('.tab-btn').forEach(b => {
  if (!['overview', 'histogram', 'query'].includes(b.dataset.tab)) b.remove();
});
`;
const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-__NONCE__'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; base-uri 'none'; form-action 'none'">
<title>HeapLens IntelliJ prototype</title><style>
:root {
 --vscode-editor-background:#202124; --vscode-foreground:#ededed;
 /* JCEF must supply the opaque surfaces normally injected by VS Code. */
 --vscode-editorGroupHeader-tabsBackground:#202124;
 --vscode-editorWidget-background:#28292c; --vscode-list-hoverBackground:#343539;
 --vscode-editor-foreground:#ededed; --vscode-panel-border:#505050;
 --vscode-input-background:#303134; --vscode-input-foreground:#ededed;
 --vscode-input-border:#707070; --vscode-button-background:#176ac5;
 --vscode-button-foreground:white; --vscode-focusBorder:#6baaff;
 --vscode-editorError-foreground:#ff7777; --vscode-font-family:system-ui;
 --vscode-editor-font-family:monospace; --vscode-font-size:13px;
}
${styles}
${layout}
${histogramStyles}
#report-actions, .why-alive-btn { display:none!important; }
</style></head><body>${template}
<script nonce="__NONCE__">${d3.replace(/<\/script/gi, '<\\/script')}</script>
<script nonce="__NONCE__">
(function() {
const vscode = {postMessage: function(message) { __BRIDGE__; }};
var analysisData = null;
${setup}
${parts}
${histogram}
${queryLifecycle}
onMessage('analysisProgress', function(msg) {
  if (msg.stage !== 'loading') return;
  analysisData = null; _analysisMsg = null; _tabRendered = {};
  document.getElementById('stats-bar').textContent = 'Waiting for analysis...';
  ['top-objects-table','diagnosis-section','pie-chart','bar-chart'].forEach(function(id) {
    document.getElementById(id).textContent = '';
  });
});
onMessage('analysisComplete', function(msg) { analysisData = msg; });
vscode.postMessage({command:'ready'});
})();
</script></body></html>`;
// Syntax-check the generated application script before it reaches either IDE.
new vm.Script(`(function(){const vscode={postMessage(){}};var analysisData=null;${setup}${parts}${queryLifecycle}})()`);
const output = path.resolve(__dirname, '../build/generated/webview/webview');
new vm.Script(histogram);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'index.html'), html);
console.log('Generated shared Overview/Histogram/HeapQL UI. No VS Code source modified.');
