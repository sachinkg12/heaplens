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
// Extract the existing pure report-formatting statements at build time, without
// importing the VS Code host at runtime or keeping a second report implementation.
const providerSource=fs.readFileSync(path.join(root,'src/hprofEditorProvider.ts'),'utf8');
const providerAst=ts.createSourceFile('provider.ts',providerSource,ts.ScriptTarget.Latest,true);
let reportMethod;
function findReport(node) {
  if(ts.isMethodDeclaration(node) && node.name.getText(providerAst)==='handleCopyReport') reportMethod=node;
  ts.forEachChild(node,findReport);
}
findReport(providerAst);
const reportStatements=reportMethod.body.statements;
const reportStart=reportStatements.findIndex(s=>s.getText(providerAst).startsWith('const lines:'));
const reportEnd=reportStatements.findIndex(s=>s.getText(providerAst).startsWith('const report ='));
if(reportStart<0 || reportEnd<reportStart) throw new Error('Shared report formatter changed; audit host contract');
const report=ts.transpileModule('function buildIncidentReport(data:any,hprofPath:string) {'+
  reportStatements.slice(reportStart,reportEnd+1).map(s=>s.getText(providerAst)).join('\n').replaceAll('this.fmtBytes','fmt')+
  '\nreturn report;}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const objectAdapter=fs.readFileSync(path.join(__dirname,'../src/main/webview/object-adapter.js'),'utf8');
const objectViews=[['gcPath','getGcPathJs'],['inspector','getInspectorJs'],['flamegraph','getFlamegraphJs']]
  .map(([file,name])=>exported('js/'+file,name)).join('\n');
const template = exported('template', 'getHtmlTemplate');
const queryLifecycle = fs.readFileSync(path.join(__dirname, '../src/main/webview/query-lifecycle.js'), 'utf8');
const layout = fs.readFileSync(path.join(__dirname, '../src/main/webview/layout.css'), 'utf8');
const appearance = fs.readFileSync(path.join(__dirname, '../src/main/webview/appearance-adapter.js'), 'utf8');
const histogramStyles = fs.readFileSync(path.join(__dirname, '../src/main/webview/histogram.css'), 'utf8');
const histogramAdapter = fs.readFileSync(path.join(__dirname, '../src/main/webview/histogram-adapter.js'), 'utf8');
const dominatorStyles = fs.readFileSync(path.join(__dirname, '../src/main/webview/dominator.css'), 'utf8');
const dominatorAdapter = fs.readFileSync(path.join(__dirname, '../src/main/webview/dominator-adapter.js'), 'utf8');
const sourceStyles = fs.readFileSync(path.join(__dirname, '../src/main/webview/source.css'), 'utf8');
const sourceAdapter = fs.readFileSync(path.join(__dirname, '../src/main/webview/source-adapter.js'), 'utf8');
const chatStyles = fs.readFileSync(path.join(__dirname, '../src/main/webview/chat.css'), 'utf8');
const chatAdapter = fs.readFileSync(path.join(__dirname, '../src/main/webview/chat-adapter.js'), 'utf8');
const chat = '(function(send, listen) {\n' +
  'const vscode = {postMessage: message => requestAi(message)};\n' +
  'const onMessage = (command, handler) => {\n' +
  '  const mapped = {chatChunk:"aiChunk",chatDone:"aiDone",chatError:"aiError"}[command];\n' +
  '  if (mapped) listen(mapped, message => {\n' +
  '    if (!acceptsAi(message)) return;\n' +
  '    if (command === "chatError" && _currentBubble && !_chatStreamBuffer) _currentBubble.remove();\n' +
  '    handler(message);\n' +
  '    aiStatus.textContent = command === "chatChunk" ? "Receiving AI response…" : command === "chatDone" ? "Response complete. Verify suggestions before acting." : (message.message || "AI request failed.");\n' +
  '    if (command !== "chatChunk") finishAi();\n' +
  '  }); else if (command === "restoreChatHistory") listen("aiHistory", handler);\n' +
  '};\n' + exported('js/chat', 'getChatJs') + '\n' + chatAdapter +
  '\n})(vscode.postMessage, onMessage);\n';
const source = '(function(send, listen) {\n' +
  'const vscode = {postMessage: send}; const depInfoCache = Object.create(null);\n' +
  'const isResolvableClass = isProjectSourceClass; const onMessage = () => {};\n' +
  exported('js/source', 'getSourceJs') + '\n' + sourceAdapter +
  '\n})(vscode.postMessage, onMessage);\n';
const dominator = '(function(send, listen, listenTab) {\n' +
  'const vscode = {postMessage: message => requestDominatorChildren(message)};\n' +
  'const depInfoCache = {}; const isResolvableClass = name => typeof name === "string" && !/^(boolean|byte|char|short|int|long|float|double)(\\[\\])*$/.test(name);\n' +
  'const onMessage = (command, handler) => {\n' +
  '  if (command === "childrenResponse") listen("dominatorChildrenResult", message => {\n' +
  '    if (acceptDominatorReply(message)) { handler(message); finishDominatorExpansion(message.objectId); }\n' +
  '  }); else listen(command, handler);\n' +
  '};\n' +
  'const onTabMessage = (tab, command, handler) => listenTab(tab, command, message => {\n' +
  '  dominatorHeap = message.summary && message.summary.reachable_heap_size; handler(message);\n' +
  '});\n' + exported('js/dominatorTree', 'getDominatorTreeJs') + '\n' + dominatorAdapter +
  '\n})(vscode.postMessage, onMessage, onTabMessage);\n';
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
const adapter=name=>fs.readFileSync(path.join(__dirname,'../src/main/webview/'+name+'-adapter.js'),'utf8');
const leaks='(function(send,listen){\nconst vscode={postMessage:send};const depInfoCache=Object.create(null);const isResolvableClass=name=>typeof name==="string" && !/^(boolean|byte|char|short|int|long|float|double)(\\[\\])*$/.test(name);const onMessage=()=>{};\n'+
  exported('js/leakSuspects','getLeakSuspectsJs')+'\n'+adapter('leaks')+'\n})(vscode.postMessage,onMessage);';
const waste='(function(){\n'+exported('js/waste','getWasteJs')+`\n
function resetWaste(){renderWaste(null);['dup','empty','overalloc','boxed'].forEach(k=>{
  document.getElementById('waste-'+k+'-title').style.display='none';document.getElementById('waste-'+k+'-table').textContent='';
});}
onMessage('analysisProgress',m=>{if(m.stage==='loading')resetWaste();});
onMessage('analysisCancelled',resetWaste);onMessage('serverCrashed',resetWaste);
})();`;
const compare='(function(send,listen){\nconst vscode={postMessage:m=>comparisonSend(m)};\n'+
  `const onMessage=(command,handler)=>listen(command,m=>{
    if(command==='compareResult' || command==='compareError'){
      if(!comparisonPending || m.requestId!==comparisonPending)return;comparisonPending=null;
    }
    handler(m);
    if(command==='analyzedFiles')Array.from(_compareSelect.options).forEach(o=>{if(o.value)o.textContent=m.labels?.[o.value] || 'Heap dump';});
  });\n`+exported('js/compare','getCompareJs')+'\n'+adapter('compare')+'\n})(vscode.postMessage,onMessage);';
const timeline='(function(send,listen){\nconst vscode={postMessage:m=>timelineSend(m)};\n'+
  `const onMessage=(command,handler)=>listen(command,m=>{
    if(command==='timelineDataResponse'){if(!timelinePending || m.requestId!==timelinePending)return;timelinePending=null;}
    handler(m);
    if(command==='allAnalyzedFiles')document.querySelectorAll('#timeline-file-list label').forEach(label=>{
      const input=label.querySelector('input');label.replaceChildren(input,document.createTextNode(' '+(m.labels?.[input.value] || 'Heap dump')));
    });
  });\n`+exported('js/timeline','getTimelineJs')+'\n'+adapter('timeline')+'\n})(vscode.postMessage,onMessage);';
const monitor='(function(send,listen){\nconst vscode={postMessage:m=>monitorSend(m)};const onMessage=listen;\n'+
  exported('js/monitor','getMonitorJs')+'\n'+adapter('monitor')+'\n})(vscode.postMessage,onMessage);';
// Preserve DOM dependencies, but expose only implemented capabilities.
const setup = `
document.querySelectorAll('.tab-btn').forEach(b => {
  if (!['overview','histogram','domtree','leaks','waste','source','query','compare','timeline','monitor','chat'].includes(b.dataset.tab)) b.remove();
});
`;
const treeMarker = '<div id="dominator-tree">';
if (!template.includes(treeMarker)) throw new Error('Shared dominator markup changed');
const sourceMarker = '<div id="source-table">';
if (!template.includes(sourceMarker)) throw new Error('Shared source markup changed');
const chatMarker = '<div class="chat-container">';
if (!template.includes(chatMarker)) throw new Error('Shared chat markup changed');
const hostTemplate = template.replace('<div id="timeline-file-list"',
  '<p>Open analyzed dumps in this project. Ordered by file modification time, which is not necessarily capture time. Growth flags are investigation hints, not proof of a leak.</p><div id="timeline-file-list"')
  .replace('<div id="monitor-histogram-table"',
  '<p>Connect to a separately running HeapLens JVM agent, not a JMX port. Use localhost or a trusted tunnel. Histogram requests require confirmation and may pause the target JVM.</p><div id="monitor-histogram-table"')
  .replace(chatMarker,
  '<div class="ai-toolbar"><button class="btn" id="ai-configure">Configure AI</button>' +
  '<button class="btn" id="ai-stop" disabled>Stop</button>' +
  '<span id="ai-status" role="status" aria-live="polite">AI is optional. Configure a provider to begin.</span></div>' + chatMarker)
  .replace('Run "HeapLens: Set LLM API Key" from the Command Palette to get started.',
    'Use Configure AI to choose a provider and set its key in IntelliJ Password Safe. Approve AI Chat once per dump-editor chat session. ' +
    'Clear, Configure AI, Retry, reopening the dump or changing AI settings requires approval again. Explain and Fix with AI ask separately. ' +
    'Completed chat turns are saved locally in the IDE system directory, not the project. Clear removes saved history. ' +
    'Text you type may be sensitive. Suggested HeapQL runs locally only when you click Run Query.')
  .replace(sourceMarker,
  '<p id="source-hint">Open project Java files, attached dependency sources, or the IDE decompiler when sources are unavailable. ' +
  'Inner classes open their containing file, not an exact declaration. Libraries must belong to this project; no automatic downloads. ' +
  'Fix with AI requires project source and explicit approval to send the entire file.</p><div id="source-status" role="status" aria-live="polite"></div>' + sourceMarker).replace(treeMarker,
  '<p class="dominator-hint">Top retained entry points from analysis; expand for immediately dominated children. ' +
  'Percentages use reachable heap. Nested rows overlap and must not be added together.</p>' +
  '<div id="dominator-status" role="status" aria-live="polite"></div>' + treeMarker);
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
 --vscode-editorError-foreground:#ff7777; --vscode-editorWarning-foreground:#f2c55c; --vscode-font-family:system-ui;
 --vscode-editor-font-family:monospace; --vscode-font-size:13px;
}
${styles}
${layout}
${histogramStyles}
${dominatorStyles}
${sourceStyles}
${chatStyles}
#local-action-status { padding: 0 16px; overflow-wrap: anywhere; font-size: var(--vscode-font-size); }
#local-action-status.local-action-error { color: var(--vscode-editorError-foreground); }
#local-action-bar { display: flex; align-items: center; flex-shrink: 0; }
#local-action-bar[hidden] { display: none; }
#local-action-stop[hidden] { display: none; }
#local-action-dismiss { margin-left: auto; }
.tab-bar { position: relative; overflow-x: auto; flex-wrap: nowrap; }
.tab-btn { flex-shrink: 0; }
</style></head><body><div id="local-action-bar" hidden><div id="local-action-status" role="status" aria-live="polite"></div><button id="local-action-stop" class="btn" hidden disabled>Stop AI action</button><button id="local-action-dismiss" class="btn" aria-label="Dismiss action status">Dismiss</button></div>${hostTemplate}
<script nonce="__NONCE__">${d3.replace(/<\/script/gi, '<\\/script')}</script>
<script nonce="__NONCE__">
(function() {
function hostSend(message) { __BRIDGE__; }
const vscode = {postMessage: dispatchHost};
var analysisData = null;
${setup}
${parts}
${appearance}
${report}
${objectAdapter}
${objectViews}
${histogram}
${dominator}
${source}
${chat}
${leaks}
${waste}
${compare}
${timeline}
${monitor}
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
new vm.Script(dominator);
new vm.Script(source);
new vm.Script(chat);
new vm.Script(objectAdapter);
[leaks,waste,compare,timeline,monitor].forEach(script=>new vm.Script(script));
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'index.html'), html);
console.log('Generated all 11 shared analysis tabs. No VS Code source modified.');
