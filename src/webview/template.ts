export function getHtmlTemplate(): string {
    return `
    <div class="tab-bar" role="tablist" aria-label="Analysis tabs">
        <button class="tab-btn active" data-tab="overview" role="tab" aria-selected="true" aria-controls="tab-overview" id="tabBtn-overview" tabindex="0">Overview</button>
        <button class="tab-btn" data-tab="histogram" role="tab" aria-selected="false" aria-controls="tab-histogram" id="tabBtn-histogram" tabindex="-1">Histogram</button>
        <button class="tab-btn" data-tab="domtree" role="tab" aria-selected="false" aria-controls="tab-domtree" id="tabBtn-domtree" tabindex="-1">Dominator Tree</button>
        <button class="tab-btn" data-tab="leaks" role="tab" aria-selected="false" aria-controls="tab-leaks" id="tabBtn-leaks" tabindex="-1">Leak Suspects</button>
        <button class="tab-btn" data-tab="waste" role="tab" aria-selected="false" aria-controls="tab-waste" id="tabBtn-waste" tabindex="-1">Waste</button>
        <button class="tab-btn" data-tab="source" role="tab" aria-selected="false" aria-controls="tab-source" id="tabBtn-source" tabindex="-1">Source</button>
        <button class="tab-btn" data-tab="query" role="tab" aria-selected="false" aria-controls="tab-query" id="tabBtn-query" tabindex="-1">Query</button>
        <button class="tab-btn" data-tab="compare" role="tab" aria-selected="false" aria-controls="tab-compare" id="tabBtn-compare" tabindex="-1">Compare</button>
        <button class="tab-btn" data-tab="timeline" role="tab" aria-selected="false" aria-controls="tab-timeline" id="tabBtn-timeline" tabindex="-1">Timeline</button>
        <button class="tab-btn" data-tab="monitor" role="tab" aria-selected="false" aria-controls="tab-monitor" id="tabBtn-monitor" tabindex="-1">Monitor</button>
        <button class="tab-btn" data-tab="chat" role="tab" aria-selected="false" aria-controls="tab-chat" id="tabBtn-chat" tabindex="-1">AI Chat</button>
    </div>

    <!-- Tab 1: Overview -->
    <div id="tab-overview" class="tab-content active" role="tabpanel" aria-labelledby="tabBtn-overview">
        <div id="file-metadata" class="file-metadata" style="display:none;"></div>
        <div id="progress-bar" class="progress-bar-container" role="status" aria-live="polite" style="display:none;"></div>
        <div class="stats-bar" id="stats-bar">
            <div class="loading">Waiting for analysis...</div>
        </div>
        <div id="report-actions">
            <button class="btn" id="copy-report-btn">Copy Incident Report</button>
            <span class="report-copied" id="report-copied">Copied!</span>
        </div>
        <div id="diagnosis-section" class="diagnosis-section"></div>
        <div class="section-title">Top Objects by Retained Size</div>
        <div id="top-objects-table"></div>
        <div class="section-title">Heap Composition</div>
        <div id="pie-chart"></div>
        <div id="bar-chart"></div>
    </div>

    <!-- Tab 2: Histogram -->
    <div id="tab-histogram" class="tab-content" role="tabpanel" aria-labelledby="tabBtn-histogram">
        <input type="text" class="search-box" id="histogram-search" placeholder="Filter by class name...">
        <div id="histogram-table"></div>
        <div id="histogram-instances-panel"></div>
    </div>

    <!-- Tab 3: Dominator Tree -->
    <div id="tab-domtree" class="tab-content" role="tabpanel" aria-labelledby="tabBtn-domtree">
        <div class="domtree-view-toggle">
            <button class="btn active" id="domtree-view-tree">Tree</button>
            <button class="btn" id="domtree-view-flame">Flame Graph</button>
        </div>
        <button class="btn" id="reset-tree-btn" style="display:none; margin-bottom: 12px;">Back to Root</button>
        <div id="domtree-header" style="display:none;">
            <div class="tree-row" style="opacity:0.6; font-size:11px; border-bottom:2px solid var(--vscode-panel-border); cursor:default;">
                <span class="tree-toggle"></span>
                <span class="tree-name" style="font-weight:bold;">Class / Object</span>
                <span class="tree-type" style="background:none; border:none;">Type</span>
                <span class="tree-shallow" style="font-weight:bold;">Shallow</span>
                <span class="tree-size" style="font-weight:bold;">Retained</span>
                <span class="tree-bar-wrap"></span>
                <span class="tree-pct" style="font-weight:bold;">%</span>
                <span class="tree-actions"><span class="tree-action-alive"></span><span class="tree-action-icon"></span><span class="tree-action-icon"></span><span class="tree-action-icon"></span></span>
            </div>
        </div>
        <div id="dominator-tree"><div class="loading">Waiting for analysis...</div></div>
        <div id="sunburst-chart"></div>
    </div>

    <!-- Tab 4: Leak Suspects -->
    <div id="tab-leaks" class="tab-content" role="tabpanel" aria-labelledby="tabBtn-leaks">
        <div class="leak-view-toggle">
            <button class="leak-toggle-btn active" data-view="object">By Object</button>
            <button class="leak-toggle-btn" data-view="class">By Class</button>
        </div>
        <div class="leak-threshold-row" id="leak-threshold-row" style="display:none;">
            <label>Min retained %:</label>
            <input type="range" id="leak-threshold-slider" min="1" max="50" value="10" step="1">
            <span id="leak-threshold-value">10%</span>
        </div>
        <div id="object-suspects"><div class="loading">Waiting for analysis...</div></div>
        <div id="leak-suspects" style="display:none;"><div class="loading">Waiting for analysis...</div></div>
    </div>

    <!-- Tab 5: Waste -->
    <div id="tab-waste" class="tab-content" role="tabpanel" aria-labelledby="tabBtn-waste">
        <div class="waste-summary-bar" id="waste-summary-bar">
            <div class="loading">Waiting for analysis...</div>
        </div>
        <input type="text" class="search-box" id="waste-search" placeholder="Filter by class name or string...">
        <div class="waste-section-title" id="waste-dup-title" style="display:none;">Duplicate Strings</div>
        <div id="waste-dup-table"></div>
        <div class="waste-section-title" id="waste-empty-title" style="display:none;">Empty Collections</div>
        <div id="waste-empty-table"></div>
        <div class="waste-section-title" id="waste-overalloc-title" style="display:none;">Over-Allocated Collections</div>
        <div id="waste-overalloc-table"></div>
        <div class="waste-section-title" id="waste-boxed-title" style="display:none;">Boxed Primitives</div>
        <div id="waste-boxed-table"></div>
    </div>

    <!-- Tab 6: Source -->
    <div id="tab-source" class="tab-content" role="tabpanel" aria-labelledby="tabBtn-source">
        <input type="text" class="search-box" id="source-search" placeholder="Filter by class name...">
        <div class="source-stats" id="source-stats"></div>
        <div id="source-table"><div class="loading">Waiting for analysis...</div></div>
    </div>

    <!-- Tab 7: Query -->
    <div id="tab-query" class="tab-content" role="tabpanel" aria-labelledby="tabBtn-query">
        <div class="query-container">
            <div class="query-input-row">
                <div class="query-editor" id="query-editor">
                    <pre class="query-highlight" id="query-highlight" aria-hidden="true"><code id="query-highlight-code"></code></pre>
                    <textarea class="query-input" id="query-input"
                        placeholder="SELECT * FROM class_histogram ORDER BY retained_size DESC LIMIT 10"
                        rows="3" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"
                        role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="query-autocomplete"></textarea>
                    <div class="query-autocomplete" id="query-autocomplete" role="listbox" style="display:none;"></div>
                </div>
                <div class="query-actions">
                    <button class="btn query-run-btn" id="query-run-btn">Run</button>
                    <button class="btn query-help-btn" id="query-help-btn" title="Show help">?</button>
                </div>
            </div>
            <div class="query-status" id="query-status" aria-live="polite"></div>
            <div class="query-history" id="query-history"></div>
            <div class="query-help" id="query-help" style="display:none;">
                <div class="query-help-title">HeapQL Reference</div>
                <div class="query-help-section">
                    <b>Tables:</b>
                    <code>instances</code> (object_id, node_type, class_name, shallow_size, retained_size),
                    <code>class_histogram</code> (class_name, instance_count, shallow_size, retained_size),
                    <code>dominator_tree</code> (same as instances; use WHERE object_id = X),
                    <code>leak_suspects</code> (class_name, object_id, retained_size, retained_percentage, description)
                </div>
                <div class="query-help-section">
                    <b>Syntax:</b> SELECT [columns|*|aggregates] FROM table [WHERE conditions] [GROUP BY col] [ORDER BY col [ASC|DESC]] [LIMIT n]
                </div>
                <div class="query-help-section">
                    <b>Aggregations:</b> COUNT(*), COUNT(col), SUM(col), AVG(col), MIN(col), MAX(col). Use with GROUP BY for per-group results.
                </div>
                <div class="query-help-section">
                    <b>Operators:</b> =, !=, &gt;, &lt;, &gt;=, &lt;=, LIKE (% wildcards). Combine with AND / OR.
                </div>
                <div class="query-help-section">
                    <b>Special commands:</b>
                    <code>:path &lt;id&gt;</code> GC root path,
                    <code>:refs &lt;id&gt;</code> referrers,
                    <code>:children &lt;id&gt;</code> dominator children,
                    <code>:info &lt;id&gt;</code> object details
                </div>
                <div class="query-help-section">
                    <b>Examples:</b><br>
                    <code>SELECT * FROM class_histogram ORDER BY retained_size DESC LIMIT 10</code><br>
                    <code>SELECT * FROM instances WHERE class_name LIKE '%Cache%' AND retained_size &gt; 1024</code><br>
                    <code>SELECT COUNT(*), SUM(retained_size) FROM instances</code><br>
                    <code>SELECT class_name, COUNT(*) FROM instances GROUP BY class_name ORDER BY count(*) DESC LIMIT 10</code><br>
                    <code>:info 12345</code>
                </div>
            </div>
            <div class="query-results" id="query-results"></div>
        </div>
    </div>

    <!-- Tab 8: Compare -->
    <div id="tab-compare" class="tab-content" role="tabpanel" aria-labelledby="tabBtn-compare">
        <div class="compare-controls">
            <label for="compare-select" style="font-size:13px; margin-right:8px;">Baseline file:</label>
            <select class="compare-select" id="compare-select">
                <option value="">-- Select a baseline --</option>
            </select>
            <button class="btn" id="compare-btn" disabled>Compare</button>
            <button class="btn" id="compare-export-md-btn" style="display:none; margin-left:8px;" title="Copy diff report to clipboard">Copy Report</button>
            <button class="btn" id="compare-export-csv-btn" style="display:none; margin-left:4px;" title="Export class changes as CSV">Export CSV</button>
            <span class="compare-status" id="compare-status" aria-live="polite"></span>
        </div>
        <div id="compare-results"></div>
    </div>

    <!-- Tab: Timeline -->
    <div id="tab-timeline" class="tab-content" role="tabpanel" aria-labelledby="tabBtn-timeline">
        <div class="timeline-controls">
            <div class="section-title" style="margin-top:0;">Snapshot Timeline</div>
            <div id="timeline-file-list" class="timeline-file-list">
                <div style="opacity:0.5; font-size:13px;">Switch to this tab to load analyzed files.</div>
            </div>
            <button class="btn" id="timeline-build-btn" disabled>Build Timeline</button>
        </div>
        <div id="timeline-charts"></div>
    </div>

    <!-- Tab: Monitor -->
    <div id="tab-monitor" class="tab-content" role="tabpanel" aria-labelledby="tabBtn-monitor">
        <div class="monitor-controls">
            <div class="monitor-connection-row">
                <label for="monitor-host">Host:</label>
                <input type="text" id="monitor-host" class="monitor-input" value="localhost" placeholder="localhost">
                <label for="monitor-port">Port:</label>
                <input type="number" id="monitor-port" class="monitor-input monitor-port-input" value="9095" min="1" max="65535">
                <button class="btn" id="monitor-connect-btn">Connect</button>
                <button class="btn" id="monitor-disconnect-btn" disabled>Disconnect</button>
                <span class="monitor-status">
                    <span class="monitor-status-dot monitor-status-disconnected" id="monitor-status-dot"></span>
                    <span id="monitor-status-text">Not connected</span>
                </span>
            </div>
        </div>
        <div class="monitor-stats-grid" id="monitor-stats-grid">
            <div class="monitor-stat-card">
                <div class="monitor-stat-label">Heap Used</div>
                <div class="monitor-stat-value" id="monitor-heap-used">--</div>
            </div>
            <div class="monitor-stat-card">
                <div class="monitor-stat-label">Heap Max</div>
                <div class="monitor-stat-value" id="monitor-heap-max">--</div>
            </div>
            <div class="monitor-stat-card">
                <div class="monitor-stat-label">Heap %</div>
                <div class="monitor-stat-value" id="monitor-heap-pct">--</div>
            </div>
            <div class="monitor-stat-card">
                <div class="monitor-stat-label">Threads</div>
                <div class="monitor-stat-value" id="monitor-threads">--</div>
            </div>
            <div class="monitor-stat-card">
                <div class="monitor-stat-label">Uptime</div>
                <div class="monitor-stat-value" id="monitor-uptime">--</div>
            </div>
            <div class="monitor-stat-card">
                <div class="monitor-stat-label">Non-Heap</div>
                <div class="monitor-stat-value" id="monitor-non-heap">--</div>
            </div>
        </div>
        <div class="monitor-charts-row">
            <div class="monitor-gauge-container" id="monitor-gauge"></div>
            <div class="monitor-line-container" id="monitor-line-chart"></div>
        </div>
        <div class="monitor-gc-section">
            <div class="section-title">GC Collectors</div>
            <div id="monitor-gc-stats"><div style="opacity:0.5;">Connect to view GC stats</div></div>
        </div>
        <div class="monitor-histogram-section">
            <div class="section-title">Class Histogram (On-Demand)</div>
            <button class="btn" id="monitor-histogram-btn" disabled>Snapshot Histogram</button>
            <div id="monitor-histogram-table"></div>
        </div>
    </div>

    <!-- Tab 9: AI Chat -->
    <div id="tab-chat" class="tab-content" role="tabpanel" aria-labelledby="tabBtn-chat">
        <div class="chat-container">
            <div class="chat-messages" id="chat-messages">
                <div class="chat-placeholder" id="chat-placeholder">
                    Ask questions about your heap dump analysis.<br>
                    Configure your API key in Settings > HeapLens to get started.
                </div>
            </div>
            <div class="chat-input-row">
                <textarea class="chat-input" id="chat-input" placeholder="Ask about your heap dump..." rows="1"></textarea>
                <button class="chat-send" id="chat-send">Send</button>
                <button class="chat-clear" id="chat-clear" title="Clear chat history">Clear</button>
            </div>
        </div>
    </div>

    <div id="gc-path-container"></div>
    <div id="inspector-panel" class="inspector-panel"></div>
    <div class="source-toast" id="source-toast"></div>
    `;
}
