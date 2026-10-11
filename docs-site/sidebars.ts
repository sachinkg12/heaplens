import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';
const sidebars:SidebarsConfig={docsSidebar:[
  {type:'category',label:'Getting started',collapsed:false,items:[
    'getting-started/choose-host','getting-started/installation','getting-started/quick-start','getting-started/intellij','getting-started/standalone','getting-started/remote-development','getting-started/generating-heap-dumps']},
  {type:'category',label:'Heap concepts',items:[
    'concepts/heap-dump-fundamentals','concepts/retained-vs-shallow-size','concepts/dominator-tree','concepts/gc-roots','concepts/leak-detection','concepts/waste-analysis']},
  {type:'category',label:'Views and actions',items:[
    'tabs-guide/overview-tab','tabs-guide/histogram-tab','tabs-guide/dominator-tree-tab','tabs-guide/leak-suspects-tab','tabs-guide/waste-tab','tabs-guide/source-tab','tabs-guide/query-tab','tabs-guide/compare-tab','tabs-guide/timeline-tab','tabs-guide/monitor-tab','tabs-guide/ai-chat-tab','tabs-guide/object-inspector']},
  {type:'category',label:'AI and privacy',items:[
    'ai-integration/overview','ai-integration/api-key-setup','ai-integration/chat-participant','ai-integration/privacy','runbook/intellij-privacy-policy']},
  {type:'category',label:'MCP integration',items:['mcp/introduction','mcp/setup','mcp/tools-reference']},
  {type:'category',label:'Reference',items:['api-reference/heapql','api-reference/rpc-methods','api-reference/data-structures']},
  {type:'category',label:'Architecture and contributing',items:['architecture/system-overview','architecture/rust-backend','architecture/typescript-frontend','architecture/data-flow','architecture/contributing']},
  {type:'category',label:'Operations and support',items:['runbook/troubleshooting','runbook/performance-tuning','runbook/recorded-measurements','runbook/telemetry','runbook/support','runbook/debugging-webview']},
]};
export default sidebars;
