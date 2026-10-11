'use strict';
// Composition of the existing renderers and host-neutral provider/prompt assets.
// Neither IDE's source tree or installed plugin is rewritten by this build.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const script of ['build-webview.cjs', 'build-ai-resources.cjs'])
    execFileSync(process.execPath, [path.join(root, 'intellij-plugin/scripts', script)], { stdio: 'inherit' });
const out = path.join(__dirname, 'build');
fs.mkdirSync(out, { recursive: true });
let html = fs.readFileSync(path.join(root, 'intellij-plugin/build/generated/webview/webview/index.html'), 'utf8');
html = html.replace("connect-src 'none'", "connect-src 'self'").replace('HeapLens IntelliJ prototype', 'HeapLens local browser')
    .replace('function hostSend(message) { __BRIDGE__; }', 'function hostSend(message) { window.heaplensSend(message); }')
    .replace('function buildIncidentReport(', `// Attribute-safe escaping: heap class/field names are untrusted, including quotes.
escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function buildIncidentReport(`)
    .replace('set its key in IntelliJ Password Safe', 'keep its key in memory in this local browser session')
    .replace('Completed chat turns are saved locally in the IDE system directory, not the project. Clear removes saved history.', 'Chat history lasts only until this CLI session ends. Download the conversation if you want to keep it. Clear deletes the in-memory history.')
    .replace('Open project Java files, attached dependency sources, or the IDE decompiler when sources are unavailable. ', 'Open Java files from --source-root directories in the local source viewer. No dependency-JAR lookup or decompiler is bundled. ')
    .replace('Libraries must belong to this project; no automatic downloads. ', 'Missing sources are reported explicitly; no automatic downloads. ')
    .replace('Open analyzed dumps in this project.', 'Analyze the dumps supplied to this CLI session.')
    .replace('<body>', `<body><div id="browser-toolbar"><strong>HeapLens</strong><select id="browser-dump" aria-label="Heap dump"></select><span id="browser-status" role="status"></span><button id="browser-retry" class="btn">Retry</button><button id="browser-cancel" class="btn">Cancel</button><button id="browser-history" class="btn">Export chat</button><button id="browser-close" class="btn">Close dump</button><button id="browser-stop" class="btn">Stop CLI</button></div><dialog id="browser-dialog"></dialog>`)
    .replace('</style>', `#browser-toolbar{display:flex;gap:10px;padding:10px;align-items:center;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid #505050}#browser-status{flex:1}dialog{color:#ededed;background:#28292c;border:1px solid #707070;border-radius:8px;padding:22px;max-width:min(1000px,90vw);max-height:85vh;overflow:auto}dialog::backdrop{background:#0009}dialog p{white-space:pre-wrap}dialog label{display:block;margin:12px 0}dialog input,dialog select{width:100%;padding:8px;background:#303134;color:#ededed;border:1px solid #707070}dialog pre{white-space:pre-wrap;overflow-wrap:anywhere}dialog .actions{display:flex;gap:10px;margin-top:18px}dialog .diff{display:grid;grid-template-columns:1fr 1fr;gap:12px}dialog textarea{height:50vh;min-width:30vw;background:#202124;color:#ededed}body{display:flex;flex-direction:column;height:100vh}#browser-toolbar[hidden]{display:none}</style>`);
html=html.replace('<button id="browser-stop"','<button id="browser-telemetry" class="btn">Telemetry</button><button id="browser-stop"');
const client = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
new vm.Script(client);
html = html.replace('<script nonce="__NONCE__">', `<script nonce="__NONCE__">${client.replace(/<\/script/gi, '<\\/script')}</script><script nonce="__NONCE__">`);
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const file of ['providers.json', 'system-prompt.txt', 'fix-system-prompt.txt'])
    fs.copyFileSync(path.join(root, 'intellij-plugin/build/generated/ai/ai', file), path.join(out, file));
// Reuse the prompt builders/sanitizer without a VS Code dependency at runtime.
const ts = require('../node_modules/typescript');
fs.writeFileSync(path.join(out, 'prompts.cjs'), ts.transpileModule(fs.readFileSync(path.join(root, 'src/promptTemplates.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
console.log('Generated standalone browser assets from shared renderers.');
