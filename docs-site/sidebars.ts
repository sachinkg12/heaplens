import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: '\uD83D\uDE80 Getting Started',
      items: [
        'getting-started/installation',
        'getting-started/quick-start',
        'getting-started/generating-heap-dumps',
      ],
      collapsed: false,
    },
    {
      type: 'category',
      label: '\uD83E\uDDE0 Concepts',
      items: [
        'concepts/heap-dump-fundamentals',
        'concepts/dominator-tree',
        'concepts/retained-vs-shallow-size',
        'concepts/gc-roots',
        'concepts/leak-detection',
        'concepts/waste-analysis',
      ],
      collapsed: false,
    },
    {
      type: 'category',
      label: '\uD83D\uDCCA Views Guide',
      items: [
        'tabs-guide/overview-tab',
        'tabs-guide/histogram-tab',
        'tabs-guide/dominator-tree-tab',
        'tabs-guide/leak-suspects-tab',
        'tabs-guide/waste-tab',
        'tabs-guide/source-tab',
        'tabs-guide/ai-chat-tab',
        'tabs-guide/query-tab',
        'tabs-guide/compare-tab',
        'tabs-guide/timeline-tab',
        'tabs-guide/object-inspector',
      ],
      collapsed: false,
    },
    {
      type: 'category',
      label: '\uD83E\uDD16 AI Integration',
      items: [
        'ai-integration/overview',
        'ai-integration/api-key-setup',
        'ai-integration/chat-participant',
        'ai-integration/privacy',
      ],
    },
    {
      type: 'category',
      label: '\uD83C\uDFD7\uFE0F Architecture',
      items: [
        'architecture/system-overview',
        'architecture/rust-backend',
        'architecture/typescript-frontend',
        'architecture/data-flow',
      ],
    },
    {
      type: 'category',
      label: '\uD83D\uDD0C MCP Integration',
      items: [
        'mcp/introduction',
        'mcp/setup',
        'mcp/tools-reference',
      ],
    },
    {
      type: 'category',
      label: '\uD83D\uDCE1 API Reference',
      items: [
        'api-reference/rpc-methods',
        'api-reference/data-structures',
      ],
    },
    {
      type: 'category',
      label: '\uD83D\uDCCB Runbook',
      items: [
        'runbook/troubleshooting',
        'runbook/telemetry',
        'runbook/debugging-webview',
        'runbook/performance-tuning',
      ],
    },
  ],
};

export default sidebars;
