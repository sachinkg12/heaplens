export function getStyles(): string {
    return `
        /* Spacing scale */
        :root {
            --hl-space-xs: 4px;
            --hl-space-sm: 8px;
            --hl-space-md: 12px;
            --hl-space-lg: 16px;
            --hl-space-xl: 24px;
            --hl-space-2xl: 32px;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            overflow-x: auto;
            min-width: 480px;
        }

        /* Tab bar */
        .tab-bar {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editorGroupHeader-tabsBackground);
            position: sticky;
            top: 0;
            z-index: 100;
            overflow-x: auto;
            min-width: 0;
            flex-shrink: 0;
        }
        .tab-btn {
            flex-shrink: 0;
            padding: 10px 20px;
            border: none;
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 13px;
            border-bottom: 2px solid transparent;
            opacity: 0.7;
            transition: opacity 0.15s, border-bottom-color 0.15s;
        }
        .tab-btn:hover { opacity: 1; }
        .tab-btn.active {
            opacity: 1;
            border-bottom-color: var(--vscode-focusBorder);
            color: var(--vscode-foreground);
            font-weight: 600;
        }

        /* Tab content */
        .tab-content { display: none; padding: 16px; }
        .tab-content.active { display: block; }

        /* Stats bar */
        .stats-bar {
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
            margin-bottom: 20px;
        }
        .stat-card {
            padding: var(--hl-space-md) 20px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            min-width: 140px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }
        .stat-card .label {
            font-size: 11px;
            text-transform: uppercase;
            opacity: 0.7;
            margin-bottom: 4px;
        }
        .stat-card .value {
            font-size: 20px;
            font-weight: bold;
        }

        /* Tables */
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }
        th, td {
            padding: 8px 12px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        th {
            background: var(--vscode-editorWidget-background);
            cursor: pointer;
            user-select: none;
            position: sticky;
            top: 42px;
            z-index: 10;
            font-weight: 600;
            border-bottom: 2px solid var(--vscode-panel-border);
        }
        th:hover { background: var(--vscode-list-hoverBackground); }
        th .sort-arrow { margin-left: 4px; opacity: 0.5; }
        tr:hover { background: var(--vscode-list-hoverBackground); }
        tbody tr:nth-child(even) { background: rgba(128,128,128,0.04); }
        tbody tr:nth-child(even):hover { background: var(--vscode-list-hoverBackground); }
        .right { text-align: right; }

        /* Search */
        .search-box {
            padding: 6px 12px;
            margin-bottom: 12px;
            width: 100%;
            max-width: 400px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 13px;
        }
        .search-box:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }

        /* Dominator tree */
        .tree-row {
            display: flex;
            align-items: center;
            padding: 6px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .tree-row.expandable { cursor: pointer; }
        .tree-row:hover { background: var(--vscode-list-hoverBackground); }
        .tree-toggle { width: 20px; text-align: center; opacity: 0.6; flex-shrink: 0; font-size: 11px; }
        .tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tree-type {
            font-size: 10px;
            padding: 1px 5px;
            border-radius: 3px;
            margin-left: 8px;
            flex-shrink: 0;
            opacity: 0.7;
        }
        .tree-type.array { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
        .tree-type.instance { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
        .tree-shallow { min-width: 80px; text-align: right; opacity: 0.5; font-size: 12px; flex-shrink: 0; }
        .tree-size { min-width: 90px; text-align: right; opacity: 0.8; flex-shrink: 0; }
        .tree-bar-wrap { width: 60px; flex-shrink: 0; margin: 0 8px; }
        .tree-bar { height: 4px; border-radius: 2px; background: var(--vscode-progressBar-background); min-width: 1px; }
        .tree-pct { min-width: 50px; text-align: right; opacity: 0.6; font-size: 12px; flex-shrink: 0; }
        .tree-actions { display: flex; align-items: center; flex-shrink: 0; margin-left: 4px; }
        .tree-action-slot { display: inline-flex; align-items: center; justify-content: center; }
        .tree-action-alive { width: 76px; }
        .tree-action-icon { width: 24px; }
        .tree-children { padding-left: 20px; }
        .tree-row.leaf { opacity: 0.8; }
        .tree-row.leaf .tree-toggle { opacity: 0.3; }
        .tree-show-more {
            padding: 6px 12px;
            font-size: 12px;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            opacity: 0.8;
        }
        .tree-show-more:hover { opacity: 1; text-decoration: underline; }
        .tree-source {
            margin-left: 6px;
            flex-shrink: 0;
            cursor: pointer;
            opacity: 0;
            font-size: 12px;
            transition: opacity 0.15s;
        }
        .tree-row:hover .tree-source { opacity: 0.6; }
        .tree-source:hover { opacity: 1 !important; }
        .dep-badge {
            display: inline-block;
            font-size: 10px;
            padding: 1px 6px;
            border-radius: 3px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            opacity: 0.8;
            margin-left: 6px;
            white-space: nowrap;
        }
        .dep-badge.workspace { background: var(--vscode-testing-iconPassed, #388a34); }
        .dep-badge.decompiled { opacity: 0.6; font-style: italic; }

        /* Leak view toggle (segmented control) */
        .leak-view-toggle {
            display: inline-flex;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            overflow: hidden;
            margin-bottom: 16px;
        }
        .leak-toggle-btn {
            padding: 6px 16px;
            font-size: 12px;
            font-weight: 600;
            border: none;
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer;
            transition: background 0.15s, color 0.15s;
            font-family: var(--vscode-font-family);
            opacity: 0.7;
        }
        .leak-toggle-btn:hover {
            opacity: 1;
        }
        .leak-toggle-btn.active {
            background: var(--vscode-focusBorder);
            color: var(--vscode-editor-background);
            opacity: 1;
        }
        .suspect-obj-id {
            font-size: 12px;
            opacity: 0.6;
            font-family: var(--vscode-editor-font-family, monospace);
            margin-left: 8px;
        }

        /* Leak suspect cards */
        .suspect-card {
            padding: var(--hl-space-lg);
            margin-bottom: var(--hl-space-md);
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            border-left: 4px solid var(--vscode-editorWarning-foreground);
            box-shadow: 0 1px 3px rgba(0,0,0,0.08);
            transition: box-shadow 0.15s, transform 0.15s;
        }
        .suspect-card:hover {
            box-shadow: 0 2px 8px rgba(0,0,0,0.14);
            transform: translateY(-1px);
        }
        .suspect-card.high { border-left-color: var(--vscode-editorError-foreground); }
        .suspect-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .suspect-class { font-weight: bold; font-size: 14px; }
        .suspect-badge {
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: bold;
        }
        .suspect-badge.high {
            background: var(--vscode-editorError-foreground);
            color: var(--vscode-editor-background);
        }
        .suspect-badge.medium {
            background: var(--vscode-editorWarning-foreground);
            color: var(--vscode-editor-background);
        }
        .suspect-desc { opacity: 0.8; font-size: 13px; }
        .go-to-source-link {
            cursor: pointer;
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            margin-left: 8px;
        }
        .go-to-source-link:hover { text-decoration: underline; }
        .leak-pagination {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 0;
            justify-content: center;
        }
        .leak-page-info {
            font-size: 12px;
            opacity: 0.7;
        }
        .leak-threshold-row {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 16px;
            font-size: 13px;
        }
        .leak-threshold-row input[type="range"] {
            flex: 0 0 200px;
            accent-color: var(--vscode-focusBorder);
        }
        .leak-threshold-row span {
            min-width: 36px;
            font-weight: bold;
        }

        /* Charts */
        #pie-chart { width: 100%; margin: 20px auto; }
        #bar-chart { width: 100%; margin: 20px auto; }
        #sunburst-chart { width: 100%; display: flex; justify-content: center; margin-top: 16px; }

        /* AI Chat tab */
        .chat-container {
            display: flex;
            flex-direction: column;
            height: calc(100vh - 60px);
        }
        .chat-messages {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
        }
        .chat-bubble {
            max-width: 80%;
            padding: 10px 14px;
            margin-bottom: 10px;
            border-radius: 8px;
            font-size: 13px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .chat-bubble.user {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            margin-left: auto;
            border-bottom-right-radius: 2px;
        }
        .chat-bubble.assistant {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            margin-right: auto;
            border-bottom-left-radius: 2px;
        }
        .chat-bubble.error {
            background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
            border: 1px solid var(--vscode-editorError-foreground);
            margin-right: auto;
            border-bottom-left-radius: 2px;
        }
        .chat-bubble.rendered {
            white-space: normal;
        }
        .chat-bubble.rendered p {
            margin: 0 0 8px 0;
        }
        .chat-bubble.rendered p:last-child {
            margin-bottom: 0;
        }
        .chat-bubble.rendered pre.md-code-block {
            background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
            padding: 8px 10px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 6px 0;
            font-size: 12px;
        }
        .chat-bubble.rendered code.md-inline-code {
            background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
            padding: 1px 4px;
            border-radius: 3px;
            font-size: 12px;
        }
        .chat-bubble.rendered .md-h1,
        .chat-bubble.rendered .md-h2,
        .chat-bubble.rendered .md-h3 {
            font-weight: bold;
            margin: 8px 0 4px 0;
        }
        .chat-bubble.rendered .md-h1 { font-size: 16px; }
        .chat-bubble.rendered .md-h2 { font-size: 14px; }
        .chat-bubble.rendered .md-li {
            margin: 2px 0 2px 12px;
        }
        .chat-input-row {
            display: flex;
            gap: 8px;
            padding: 12px 16px;
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editorWidget-background);
        }
        .chat-input {
            flex: 1;
            padding: 8px 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 13px;
            font-family: inherit;
            resize: none;
            min-height: 36px;
            max-height: 120px;
        }
        .chat-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        .chat-send {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            align-self: flex-end;
        }
        .chat-send:hover { background: var(--vscode-button-hoverBackground); }
        .chat-send:disabled { opacity: 0.5; cursor: not-allowed; }
        .chat-clear {
            padding: 8px 12px;
            background: transparent;
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            align-self: flex-end;
            opacity: 0.6;
        }
        .chat-clear:hover { opacity: 1; }
        /* Chat HeapQL integration */
        .chat-run-query-btn {
            display: inline-block;
            margin: 4px 0 8px;
            padding: 4px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }
        .chat-run-query-btn:hover { background: var(--vscode-button-hoverBackground); }
        .chat-run-query-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .chat-query-result {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            margin: 4px 0 8px;
            overflow-x: auto;
        }
        .chat-query-result table {
            width: 100%;
            border-collapse: collapse;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px;
        }
        .chat-query-result th {
            text-align: left;
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: 600;
            font-size: 10px;
            opacity: 0.7;
        }
        .chat-query-result td {
            padding: 3px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .chat-query-result tr:hover { background: var(--vscode-list-hoverBackground); }
        .chat-query-status {
            text-align: right;
            padding: 4px 8px;
            font-size: 10px;
            opacity: 0.5;
        }
        .chat-query-more {
            text-align: center;
            padding: 6px 8px;
            font-size: 11px;
            opacity: 0.6;
        }
        .chat-query-link {
            color: var(--vscode-textLink-foreground, #3794ff);
            cursor: pointer;
            text-decoration: none;
        }
        .chat-query-link:hover { text-decoration: underline; }
        .chat-placeholder {
            text-align: center;
            opacity: 0.5;
            padding: 40px;
            font-size: 13px;
        }

        /* Query tab */
        .query-container { max-width: 100%; }
        .query-input-row { display: flex; gap: 8px; margin-bottom: 8px; }

        /* Query editor overlay */
        .query-editor {
            position: relative;
            flex: 1;
            min-height: 0;
        }
        .query-input {
            position: relative;
            z-index: 2;
            width: 100%;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 13px;
            line-height: 1.5;
            padding: 8px 12px;
            background: transparent;
            color: transparent;
            caret-color: var(--vscode-editorCursor-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            resize: vertical;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow: auto;
        }
        .query-input::placeholder { color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.6)); }
        .query-input:focus { outline: none; border-color: var(--vscode-focusBorder); }
        .query-highlight {
            position: absolute;
            inset: 0;
            z-index: 1;
            pointer-events: none;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 13px;
            line-height: 1.5;
            padding: 8px 12px;
            margin: 0;
            border: 1px solid transparent;
            border-radius: 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow: hidden;
        }
        .query-highlight code {
            font-family: inherit;
            font-size: inherit;
            line-height: inherit;
            background: none;
            padding: 0;
        }

        /* HeapQL token colors */
        .hql-keyword { color: var(--vscode-debugTokenExpression-name, #4fc1ff); font-weight: bold; }
        .hql-table { color: var(--vscode-symbolIcon-classForeground, #ee9d28); }
        .hql-column { color: var(--vscode-symbolIcon-fieldForeground, #75beff); }
        .hql-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
        .hql-number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
        .hql-operator { color: var(--vscode-foreground); opacity: 0.9; }
        .hql-special { color: var(--vscode-editorWarning-foreground, #cca700); font-weight: bold; }
        .hql-star { color: var(--vscode-debugTokenExpression-name, #4fc1ff); font-weight: bold; }

        /* Autocomplete dropdown */
        .query-autocomplete {
            position: absolute;
            z-index: 10;
            background: var(--vscode-editorSuggestWidget-background, var(--vscode-editorWidget-background));
            border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-panel-border));
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            box-shadow: 0 2px 8px rgba(0,0,0,0.25);
            min-width: 180px;
            font-size: 13px;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .query-ac-item {
            display: flex;
            align-items: center;
            padding: 4px 10px;
            cursor: pointer;
            gap: 8px;
        }
        .query-ac-item:hover,
        .query-ac-item.active {
            background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground));
            color: var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground));
        }
        .query-ac-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .query-ac-kind {
            font-size: 10px;
            padding: 1px 5px;
            border-radius: 3px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            flex-shrink: 0;
            opacity: 0.8;
        }

        .query-actions { display: flex; flex-direction: column; gap: 4px; }
        .query-run-btn { min-width: 60px; }
        .query-help-btn { min-width: 60px; font-size: 16px; font-weight: bold; }
        .query-status {
            font-size: 12px;
            opacity: 0.7;
            margin-bottom: 8px;
            min-height: 18px;
        }
        .query-status.error { color: var(--vscode-editorError-foreground); opacity: 1; }
        .query-history {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
            margin-bottom: 8px;
        }
        .query-history-item {
            padding: 2px 8px;
            font-size: 11px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            cursor: pointer;
            max-width: 300px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .query-history-item:hover { background: var(--vscode-list-hoverBackground); }
        .query-help {
            padding: 12px;
            margin-bottom: 12px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            font-size: 12px;
            line-height: 1.6;
        }
        .query-help-title { font-weight: bold; font-size: 13px; margin-bottom: 8px; }
        .query-help-section { margin-bottom: 6px; }
        .query-help code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 3px;
            font-size: 12px;
        }
        .query-limit-warning {
            padding: 8px 12px;
            margin-bottom: 8px;
            background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, var(--vscode-editorWidget-background));
            border: 1px solid var(--vscode-editorWarning-foreground);
            border-radius: 4px;
            font-size: 12px;
            color: var(--vscode-editorWarning-foreground);
        }
        .query-results { overflow-x: auto; }
        .query-results table { font-size: 12px; }
        .query-results th { font-size: 11px; cursor: default; position: static; }

        .loading {
            padding: 40px;
            text-align: center;
            opacity: 0.6;
            font-size: 14px;
        }

        .section-title {
            font-size: 16px;
            font-weight: bold;
            margin: 20px 0 12px 0;
        }

        .btn {
            padding: 6px 14px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            margin-right: 8px;
        }
        .btn:hover { background: var(--vscode-button-hoverBackground); }

        /* Source-not-found toast */
        .source-toast {
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            padding: 10px 20px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
            border-radius: 6px;
            font-size: 12px;
            opacity: 0;
            transition: opacity 0.3s;
            z-index: 200;
            pointer-events: none;
            max-width: 80%;
            text-align: center;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        }
        .source-toast.visible { opacity: 1; }

        /* GC Root Path Breadcrumb */
        .gc-path-breadcrumb {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 10px 16px;
            margin-bottom: 12px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            overflow-x: auto;
            white-space: nowrap;
            position: relative;
        }
        .gc-path-label {
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            opacity: 0.6;
            margin-right: 8px;
            flex-shrink: 0;
        }
        .gc-path-node {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 12px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            flex-shrink: 0;
        }
        .gc-path-node.root {
            background: var(--vscode-testing-iconPassed, #388a34);
            color: #fff;
        }
        .gc-path-node.target {
            background: var(--vscode-editorError-foreground);
            color: #fff;
        }
        .gc-path-arrow {
            opacity: 0.4;
            font-size: 11px;
            flex-shrink: 0;
        }
        .gc-path-close {
            position: absolute;
            right: 8px;
            top: 50%;
            transform: translateY(-50%);
            cursor: pointer;
            opacity: 0.5;
            font-size: 14px;
            padding: 2px 6px;
            border: none;
            background: none;
            color: var(--vscode-foreground);
        }
        .gc-path-close:hover { opacity: 1; }
        .tree-pin {
            margin-left: 6px;
            flex-shrink: 0;
            cursor: pointer;
            opacity: 0;
            font-size: 12px;
            transition: opacity 0.15s;
        }
        .tree-row:hover .tree-pin { opacity: 0.6; }
        .tree-pin:hover { opacity: 1 !important; }
        .tree-field-name {
            color: var(--vscode-textLink-foreground, #3794ff);
            margin-right: 4px;
            font-weight: 500;
        }
        .tree-inspect {
            margin-left: 6px;
            flex-shrink: 0;
            cursor: pointer;
            opacity: 0;
            font-size: 12px;
            transition: opacity 0.15s;
        }
        .tree-row:hover .tree-inspect { opacity: 0.6; }
        .tree-inspect:hover { opacity: 1 !important; }
        .tree-refs {
            margin-left: 6px;
            flex-shrink: 0;
            cursor: pointer;
            opacity: 0;
            font-size: 12px;
            transition: opacity 0.15s;
        }
        .tree-row:hover .tree-refs { opacity: 0.6; }
        .tree-refs:hover { opacity: 1 !important; }
        .referrer-action { opacity: 0.7 !important; cursor: pointer; }
        .referrer-action:hover { opacity: 1 !important; }
        /* Referrers overlay */
        .referrers-overlay {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            margin: 8px 0;
            box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        }
        .referrers-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .referrers-title { font-weight: 600; font-size: 12px; }
        .referrers-list { max-height: 300px; overflow-y: auto; }
        .referrer-row {
            display: flex;
            align-items: center;
            padding: 5px 12px;
            font-size: 12px;
            gap: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            cursor: default;
        }
        .referrer-row:last-child { border-bottom: none; }
        .referrer-row:hover { background: var(--vscode-list-hoverBackground); }
        .referrer-field {
            color: var(--vscode-textLink-foreground, #3794ff);
            font-weight: 500;
        }
        .referrer-class { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .referrer-type {
            font-size: 10px;
            padding: 1px 6px;
            border-radius: 3px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            flex-shrink: 0;
        }
        .referrer-size { opacity: 0.7; flex-shrink: 0; min-width: 60px; text-align: right; }
        .referrer-actions { display: flex; gap: 4px; flex-shrink: 0; }
        .gc-path-field {
            font-style: italic;
            opacity: 0.7;
            font-size: 11px;
            margin: 0 2px;
        }
        /* Inspector panel */
        .inspector-panel {
            position: fixed;
            top: 0;
            right: 0;
            width: 380px;
            height: 100%;
            background: var(--vscode-editor-background);
            border-left: 2px solid var(--vscode-panel-border);
            border-top-left-radius: 8px;
            overflow-y: auto;
            z-index: 1000;
            display: none;
            box-shadow: -4px 0 16px rgba(0,0,0,0.18);
        }
        .inspector-panel.visible { display: block; }
        .inspector-header {
            padding: 12px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            background: var(--vscode-editor-background);
            z-index: 1;
        }
        .inspector-header h3 { margin: 0; font-size: 13px; }
        .inspector-close {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            font-size: 18px;
            cursor: pointer;
            opacity: 0.6;
            padding: 0 4px;
        }
        .inspector-close:hover { opacity: 1; }
        .inspector-body { padding: 8px 0; }
        .inspector-field {
            display: flex;
            align-items: baseline;
            padding: 5px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px;
            gap: 8px;
        }
        .inspector-field:hover { background: var(--vscode-list-hoverBackground); }
        .inspector-field-name { font-weight: 600; min-width: 100px; flex-shrink: 0; }
        .inspector-field-type { opacity: 0.5; min-width: 50px; flex-shrink: 0; }
        .inspector-field-value { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .inspector-ref-link {
            color: var(--vscode-textLink-foreground, #3794ff);
            cursor: pointer;
            text-decoration: none;
        }
        .inspector-ref-link:hover { text-decoration: underline; }
        .inspector-sizes { opacity: 0.5; font-size: 11px; flex-shrink: 0; }
        .inspector-loading { padding: 20px; text-align: center; opacity: 0.5; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid var(--vscode-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            opacity: 0.6;
        }

        /* Explain button & area (inspector) */
        .inspector-explain-btn {
            display: block;
            width: calc(100% - 32px);
            margin: 12px 16px;
            padding: 8px 12px;
            background: var(--vscode-editorWidget-background);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            text-align: center;
        }
        .inspector-explain-btn:hover { background: var(--vscode-list-hoverBackground); }
        .inspector-explain-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .inspector-explain-area {
            display: none;
            margin: 0 16px 12px;
            padding: 10px 12px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            font-size: 12px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-wrap: break-word;
            max-height: 400px;
            overflow-y: auto;
        }
        .inspector-explain-area.visible { display: block; }
        .inspector-explain-area.streaming {
            border-left: 3px solid var(--vscode-focusBorder);
        }
        .inspector-explain-area.error {
            border-color: var(--vscode-editorError-foreground);
            color: var(--vscode-editorError-foreground);
        }

        /* Explain link & area (leak suspect cards) */
        .suspect-explain-link {
            cursor: pointer;
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        .suspect-explain-link:hover { text-decoration: underline; }
        .suspect-explain-area {
            display: none;
            position: relative;
            margin-top: 10px;
            padding: 10px 12px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            font-size: 12px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-wrap: break-word;
            max-height: 400px;
            overflow-y: auto;
        }
        .explain-close-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            background: none;
            border: none;
            color: var(--vscode-foreground);
            font-size: 18px;
            cursor: pointer;
            opacity: 0.6;
            padding: 4px 8px;
            line-height: 1;
        }
        .explain-close-btn:hover {
            opacity: 1;
        }
        .suspect-explain-area.visible { display: block; }
        .suspect-explain-area.streaming {
            border-left: 3px solid var(--vscode-focusBorder);
        }
        .suspect-explain-area.error {
            border-color: var(--vscode-editorError-foreground);
            color: var(--vscode-editorError-foreground);
        }

        /* Markdown rendering in explain areas */
        .md-code-block {
            background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
            padding: 10px 12px;
            border-radius: 4px;
            margin: 8px 0;
            overflow-x: auto;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            line-height: 1.5;
            white-space: pre;
        }
        .md-code-block code { background: none; padding: 0; }
        .md-inline-code {
            background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
            padding: 1px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
        }
        .md-h1 { font-size: 16px; font-weight: bold; margin: 12px 0 6px; }
        .md-h2 { font-size: 14px; font-weight: bold; margin: 10px 0 4px; }
        .md-h3 { font-size: 13px; font-weight: bold; margin: 8px 0 4px; }
        .md-li { padding-left: 16px; position: relative; }
        .md-li-bullet, .md-li-num { position: absolute; left: 0; opacity: 0.6; }
        .inspector-explain-area p, .suspect-explain-area p { margin: 0 0 6px; }
        .inspector-explain-area.rendered, .suspect-explain-area.rendered {
            white-space: normal;
        }

        /* Histogram class links & instance panel */
        .hist-class-link {
            cursor: pointer;
            color: var(--vscode-textLink-foreground, #3794ff);
            text-decoration: none;
        }
        .hist-class-link:hover { text-decoration: underline; }
        .instance-panel {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            margin: 12px 0;
            box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        }
        .instance-panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: 600;
            font-size: 12px;
        }
        .instance-panel-close {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            font-size: 18px;
            cursor: pointer;
            opacity: 0.6;
            padding: 0 4px;
        }
        .instance-panel-close:hover { opacity: 1; }
        .instance-panel table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .instance-panel th {
            text-align: left;
            padding: 6px 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: 600;
            font-size: 11px;
            opacity: 0.7;
        }
        .instance-panel td { padding: 4px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
        .instance-panel tr:hover { background: var(--vscode-list-hoverBackground); }
        .instance-actions { display: flex; gap: 6px; align-items: center; }
        .instance-action { cursor: pointer; opacity: 0.7; }
        .instance-action:hover { opacity: 1; }

        /* Auto-Diagnosis cards */
        .diagnosis-section { margin-bottom: var(--hl-space-xl); }
        .diagnosis-card {
            padding: var(--hl-space-md) var(--hl-space-lg);
            margin-bottom: var(--hl-space-sm);
            border-radius: 6px;
            font-size: 13px;
            border-left: 4px solid var(--vscode-panel-border);
            background: var(--vscode-editorWidget-background);
            box-shadow: 0 1px 3px rgba(0,0,0,0.06);
        }
        .diagnosis-card.critical {
            border-left-color: var(--vscode-editorError-foreground);
            background: color-mix(in srgb, var(--vscode-editorError-foreground) 8%, var(--vscode-editorWidget-background));
        }
        .diagnosis-card.warning {
            border-left-color: var(--vscode-editorWarning-foreground);
            background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 8%, var(--vscode-editorWidget-background));
        }
        .diagnosis-card.info {
            border-left-color: var(--vscode-focusBorder);
        }
        .diagnosis-severity {
            font-size: 10px;
            font-weight: bold;
            text-transform: uppercase;
            margin-bottom: 4px;
        }
        .diagnosis-card.critical .diagnosis-severity { color: var(--vscode-editorError-foreground); }
        .diagnosis-card.warning .diagnosis-severity { color: var(--vscode-editorWarning-foreground); }
        .diagnosis-card.info .diagnosis-severity { color: var(--vscode-focusBorder); }
        .diagnosis-confidence {
            display: inline-block;
            font-size: 9px;
            text-transform: uppercase;
            padding: 1px 6px;
            border-radius: 8px;
            margin-left: 6px;
            vertical-align: middle;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .diagnosis-confidence.high { opacity: 1; }
        .diagnosis-confidence.medium { opacity: 0.7; }
        .diagnosis-confidence.low { opacity: 0.5; }
        .diagnosis-title { font-weight: bold; margin-bottom: 4px; }
        .diagnosis-detail { opacity: 0.8; font-size: 12px; }

        /* Report button */
        #report-actions {
            display: none;
            margin-bottom: 16px;
        }
        .report-copied {
            display: inline-block;
            margin-left: 8px;
            font-size: 12px;
            color: var(--vscode-testing-iconPassed, #388a34);
            opacity: 0;
            transition: opacity 0.3s;
        }
        .report-copied.visible { opacity: 1; }

        /* Source tab */
        .source-status {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 6px;
            vertical-align: middle;
        }
        .source-status.not-tried { background: var(--vscode-panel-border); }
        .source-status.resolving { background: var(--vscode-focusBorder); animation: pulse 1s infinite; }
        .source-status.found { background: var(--vscode-testing-iconPassed, #388a34); }
        .source-status.not-found { background: var(--vscode-editorError-foreground); opacity: 0.5; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .source-view-btn {
            padding: 3px 10px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }
        .source-view-btn:hover { background: var(--vscode-button-hoverBackground); }
        .source-view-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .source-stats {
            font-size: 12px;
            opacity: 0.6;
            margin-bottom: 12px;
        }

        /* Waste tab */
        .waste-summary-bar {
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
            margin-bottom: 20px;
        }
        .waste-stat-card {
            padding: var(--hl-space-md) 20px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            min-width: 160px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }
        .waste-stat-card .label {
            font-size: 11px;
            text-transform: uppercase;
            opacity: 0.7;
            margin-bottom: 4px;
        }
        .waste-stat-card .value {
            font-size: 20px;
            font-weight: bold;
        }
        .waste-stat-card .value.highlight {
            color: var(--vscode-editorWarning-foreground);
        }
        .waste-section-title {
            font-size: 14px;
            font-weight: bold;
            margin: 20px 0 10px 0;
            opacity: 0.9;
        }
        .waste-totals-row {
            font-weight: bold;
            border-top: 2px solid var(--vscode-panel-border);
            background: var(--vscode-editorWidget-background);
        }
        .waste-totals-row td { padding-top: 10px; }
        /* Compare tab */
        .compare-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        .compare-select {
            padding: 6px 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 13px;
            min-width: 300px;
            max-width: 500px;
        }
        .compare-select:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        .compare-status {
            font-size: 12px;
            opacity: 0.7;
            margin-left: 8px;
        }
        .compare-status.error { color: var(--vscode-editorError-foreground); opacity: 1; }
        .delta-positive { color: var(--vscode-editorError-foreground, #f44); }
        .delta-negative { color: var(--vscode-testing-iconPassed, #388a34); }
        .delta-zero { opacity: 0.5; }
        .change-badge {
            display: inline-block;
            padding: 1px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: bold;
            text-transform: uppercase;
        }
        .change-badge.new { background: var(--vscode-editorError-foreground); color: #fff; }
        .change-badge.removed { background: var(--vscode-testing-iconPassed, #388a34); color: #fff; }
        .change-badge.grew { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
        .change-badge.shrank { background: var(--vscode-focusBorder); color: #fff; }
        .change-badge.unchanged { background: var(--vscode-panel-border); opacity: 0.6; }
        .change-badge.resolved { background: var(--vscode-testing-iconPassed, #388a34); color: #fff; }
        .change-badge.persisted { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
        .compare-section-title {
            font-size: 15px;
            font-weight: bold;
            margin: 24px 0 12px 0;
        }
        .compare-stat-card {
            padding: var(--hl-space-md) 20px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            min-width: 160px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }
        .compare-stat-card .label {
            font-size: 11px;
            text-transform: uppercase;
            opacity: 0.7;
            margin-bottom: 4px;
        }
        .compare-stat-card .value {
            font-size: 18px;
            font-weight: bold;
        }
        .compare-stat-card .delta {
            font-size: 12px;
            margin-top: 2px;
        }
        .compare-leak-card {
            padding: 14px 16px;
            margin-bottom: 10px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            border-left: 4px solid var(--vscode-panel-border);
        }
        .compare-leak-card.new { border-left-color: var(--vscode-editorError-foreground); }
        .compare-leak-card.resolved { border-left-color: var(--vscode-testing-iconPassed, #388a34); }
        .compare-leak-card.persisted { border-left-color: var(--vscode-editorWarning-foreground); }

        /* Progress bar */
        .progress-bar-container {
            padding: var(--hl-space-md) var(--hl-space-lg);
            margin-bottom: var(--hl-space-md);
        }
        .progress-steps {
            display: flex;
            align-items: center;
            gap: 0;
        }
        .progress-step {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .progress-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: var(--vscode-panel-border);
            flex-shrink: 0;
            transition: background 0.3s;
        }
        .progress-step.active .progress-dot {
            background: var(--vscode-focusBorder);
            box-shadow: 0 0 6px var(--vscode-focusBorder);
            animation: pulse 1s infinite;
        }
        .progress-step.done .progress-dot {
            background: var(--vscode-testing-iconPassed, #388a34);
        }
        .progress-connector {
            width: 24px;
            height: 2px;
            background: var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .progress-connector.done {
            background: var(--vscode-testing-iconPassed, #388a34);
        }
        .progress-label {
            font-size: 12px;
            opacity: 0.8;
            white-space: nowrap;
        }
        .progress-message {
            font-size: 13px;
            padding: 4px 0;
        }

        /* File metadata */
        .file-metadata {
            display: flex;
            gap: var(--hl-space-md);
            padding: var(--hl-space-xs) var(--hl-space-lg);
            margin-bottom: var(--hl-space-sm);
            font-size: 12px;
            opacity: 0.6;
        }
        .file-meta-item {
            white-space: nowrap;
        }

        .waste-preview {
            max-width: 400px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            opacity: 0.85;
        }

        .why-alive-btn {
            display: inline-block;
            padding: 1px 8px;
            font-size: 11px;
            border-radius: 10px;
            border: 1px solid var(--vscode-button-border, var(--vscode-textLink-foreground));
            background: transparent;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            white-space: nowrap;
            vertical-align: middle;
            line-height: 18px;
        }
        .why-alive-btn:hover {
            background: var(--vscode-button-hoverBackground, rgba(255,255,255,0.1));
            color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
        }

        /* Android badge */
        .android-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: 600;
            background: #3ddc84;
            color: #1b1b1b;
            letter-spacing: 0.3px;
        }

        /* Heap type chips (Android heap regions) */
        .heap-type-chip {
            display: inline-block;
            padding: 1px 6px;
            border-radius: 8px;
            font-size: 10px;
            font-weight: 500;
            background: var(--vscode-badge-background, rgba(255,255,255,0.1));
            color: var(--vscode-badge-foreground, var(--vscode-foreground));
            margin-right: 4px;
        }

        /* Flame graph / icicle chart */
        .domtree-view-toggle {
            display: flex;
            gap: 0;
            margin-bottom: 12px;
        }
        .domtree-view-toggle .btn {
            border-radius: 0;
            margin-right: 0;
            opacity: 0.6;
            background: var(--vscode-editorWidget-background);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
        }
        .domtree-view-toggle .btn:first-child { border-radius: 4px 0 0 4px; }
        .domtree-view-toggle .btn:last-child { border-radius: 0 4px 4px 0; border-left: none; }
        .domtree-view-toggle .btn.active {
            opacity: 1;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-background);
        }
        .flame-breadcrumb {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 8px 0;
            font-size: 12px;
            margin-bottom: 8px;
            flex-wrap: wrap;
        }
        .flame-bc-link {
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            text-decoration: none;
        }
        .flame-bc-link:hover { text-decoration: underline; }
        .flame-bc-arrow { opacity: 0.4; }
        .flame-bc-current { font-weight: bold; }
        .flame-tooltip {
            position: absolute;
            padding: 6px 10px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            font-size: 12px;
            pointer-events: none;
            z-index: 50;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            max-width: 300px;
        }
        .flame-cell { cursor: pointer; }

        /* Timeline tab */
        .timeline-controls {
            margin-bottom: 16px;
        }
        .timeline-file-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 12px;
        }
        .timeline-file-item {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
        }
        .timeline-file-item:hover { background: var(--vscode-list-hoverBackground); }
        .timeline-growth-table .anomaly {
            background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 10%, var(--vscode-editorWidget-background));
        }
        .timeline-growth-table .anomaly td:last-child {
            color: var(--vscode-editorWarning-foreground);
            font-weight: bold;
            font-size: 11px;
        }

        /* Focus indicators */
        *:focus-visible {
            outline: 2px solid var(--vscode-focusBorder);
            outline-offset: -2px;
        }
        .tab-btn:focus-visible { outline-offset: -4px; }
        .tree-row:focus-visible {
            background: var(--vscode-list-focusBackground, var(--vscode-list-hoverBackground));
            outline-offset: -2px;
        }
        .search-box:focus-visible,
        .query-input:focus-visible,
        .chat-input:focus-visible,
        .compare-select:focus-visible {
            outline: 2px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }
        .tree-show-more:focus-visible { outline-offset: -2px; border-radius: 3px; }

        /* Fix with AI */
        .fix-with-ai-link {
            cursor: pointer;
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            margin-left: 8px;
        }
        .fix-with-ai-link:hover { text-decoration: underline; }
        .fix-with-ai-link.disabled {
            opacity: 0.5;
            cursor: wait;
            pointer-events: none;
        }
        .fix-with-ai-link.fixed {
            color: var(--vscode-testing-iconPassed, #388a34);
            pointer-events: none;
        }
        .tree-fix {
            margin-left: 6px;
            flex-shrink: 0;
            cursor: pointer;
            opacity: 0;
            font-size: 12px;
            transition: opacity 0.15s;
        }
        .tree-row:hover .tree-fix { opacity: 0.6; }
        .tree-fix:hover { opacity: 1 !important; }
        .source-fix-btn {
            padding: 3px 10px;
            background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
            color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            margin-left: 4px;
        }
        .source-fix-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
        .source-fix-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .source-fix-btn.fixed {
            background: var(--vscode-testing-iconPassed, #388a34);
            color: #fff;
        }

        /* ---- Monitor Tab ---- */
        .monitor-controls {
            padding: var(--hl-space-md) var(--hl-space-lg);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .monitor-connection-row {
            display: flex;
            align-items: center;
            gap: var(--hl-space-sm);
            flex-wrap: wrap;
        }
        .monitor-connection-row label {
            font-size: 13px;
            opacity: 0.8;
        }
        .monitor-input {
            padding: 4px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 3px;
            font-size: 13px;
            width: 120px;
        }
        .monitor-port-input { width: 70px; }
        .monitor-status {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-left: var(--hl-space-sm);
            font-size: 12px;
            opacity: 0.8;
        }
        .monitor-status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
        }
        .monitor-status-disconnected { background: var(--vscode-editorWidget-border, #555); }
        .monitor-status-connecting { background: #f39c12; }
        .monitor-status-connected { background: #27ae60; }
        .monitor-status-error { background: #e74c3c; }

        .monitor-stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
            gap: var(--hl-space-md);
            padding: var(--hl-space-lg);
        }
        .monitor-stat-card {
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: var(--hl-space-md);
            text-align: center;
        }
        .monitor-stat-label {
            font-size: 11px;
            opacity: 0.6;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 4px;
        }
        .monitor-stat-value {
            font-size: 20px;
            font-weight: bold;
            font-family: var(--vscode-editor-font-family, monospace);
        }

        .monitor-charts-row {
            display: flex;
            gap: var(--hl-space-lg);
            padding: 0 var(--hl-space-lg) var(--hl-space-lg);
            flex-wrap: wrap;
        }
        .monitor-gauge-container {
            flex: 0 0 200px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .monitor-line-container {
            flex: 1 1 300px;
            min-height: 200px;
        }

        .monitor-gc-section,
        .monitor-histogram-section {
            padding: 0 var(--hl-space-lg) var(--hl-space-lg);
        }
        .monitor-gc-row {
            display: flex;
            gap: var(--hl-space-lg);
            padding: 6px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 13px;
        }
        .monitor-gc-name { font-weight: 600; min-width: 150px; }
        .monitor-gc-count { opacity: 0.8; }
        .monitor-gc-time { opacity: 0.8; }

        .monitor-histogram { margin-top: var(--hl-space-md); }
    `;
}
