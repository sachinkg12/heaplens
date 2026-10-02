export function getHistogramJs(): string {
    return `
        // ---- Tab 2: Histogram ----
        // Self-contained: owns sort/filter state, pagination, % of heap column, CSV export.

        var _histSortCol = 'retained_size';
        var _histSortAsc = false;
        var _histFilter = '';
        var _histShowAll = false;
        var HISTOGRAM_PAGE_SIZE = 200;
        var _pendingInstanceClass = null;

        // Shared by the table and CSV; unknown/zero heap has no defined ratio.
        function histogramPercentage(retainedSize, reachableHeapSize) {
            if (!Number.isFinite(reachableHeapSize) || reachableHeapSize <= 0 ||
                !Number.isFinite(retainedSize) || retainedSize < 0) return 'N/A';
            var percentage = (retainedSize / reachableHeapSize) * 100;
            return Number.isFinite(percentage) ? percentage.toFixed(1) : 'N/A';
        }

        function renderHistogram(histogram, reachableHeapSize) {
            var container = document.getElementById('histogram-table');
            var sorted = histogram.slice();

            sorted.sort(function(a, b) {
                var va = a[_histSortCol], vb = b[_histSortCol];
                if (_histSortCol === 'heap_pct') {
                    // All rows share one denominator; sorting the numerator also
                    // avoids dividing by a missing or zero reachable heap.
                    va = a.retained_size;
                    vb = b.retained_size;
                }
                if (typeof va === 'string') return _histSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
                return _histSortAsc ? va - vb : vb - va;
            });

            if (_histFilter) {
                var f = _histFilter.toLowerCase();
                sorted = sorted.filter(function(e) { return e.class_name.toLowerCase().indexOf(f) !== -1; });
            }

            var totalCount = sorted.length;
            var displayRows = _histShowAll ? sorted : sorted.slice(0, HISTOGRAM_PAGE_SIZE);

            var cols = [
                { key: 'class_name', label: 'Class Name', cls: '' },
                { key: 'instance_count', label: 'Instances', cls: 'right' },
                { key: 'shallow_size', label: 'Shallow Size', cls: 'right' },
                { key: 'retained_size', label: 'Retained Size', cls: 'right' },
                { key: 'heap_pct', label: '% of Heap', cls: 'right' }
            ];

            var html = '<table><thead><tr>';
            cols.forEach(function(c) {
                var arrow = _histSortCol === c.key ? (_histSortAsc ? ' \\u25B2' : ' \\u25BC') : '';
                var title = c.key === 'heap_pct' ? ' title="Class retained size divided by reachable heap size. N/A means the percentage is unavailable."' : '';
                html += '<th class="' + c.cls + '" data-sort="' + c.key + '"' + title + '>' + c.label + '<span class="sort-arrow">' + arrow + '</span></th>';
            });
            html += '</tr></thead><tbody>';

            displayRows.forEach(function(e) {
                var pct = histogramPercentage(e.retained_size, reachableHeapSize);
                html += '<tr><td><span class="hist-class-link" data-class="' + escapeHtml(e.class_name) + '">' + escapeHtml(e.class_name) + '</span></td><td class="right">' + fmtNum(e.instance_count) + '</td><td class="right">' + fmt(e.shallow_size) + '</td><td class="right">' + fmt(e.retained_size) + '</td><td class="right">' + (pct === 'N/A' ? pct : pct + '%') + '</td></tr>';
            });
            html += '</tbody></table>';
            html += '<p class="histogram-percentage-note">Percentages use reachable heap. Classes can retain the same objects, so percentages need not sum to 100%. N/A means the percentage is unavailable.</p>';

            if (!_histShowAll && totalCount > HISTOGRAM_PAGE_SIZE) {
                html += '<div style="text-align:center;padding:12px;"><button id="show-all-histogram" style="padding:6px 16px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;">Show all ' + totalCount.toLocaleString() + ' classes</button></div>';
            }

            // Export CSV button
            html += '<div style="text-align:right;padding:8px 0;"><button class="btn" id="export-csv-btn" style="font-size:11px;">Export CSV</button></div>';

            container.innerHTML = html;

            var showAllBtn = document.getElementById('show-all-histogram');
            if (showAllBtn) {
                showAllBtn.addEventListener('click', function() {
                    _histShowAll = true;
                    renderHistogram(histogram, reachableHeapSize);
                });
            }

            container.querySelectorAll('th[data-sort]').forEach(function(th) {
                th.addEventListener('click', function() {
                    var col = th.dataset.sort;
                    if (_histSortCol === col) _histSortAsc = !_histSortAsc;
                    else { _histSortCol = col; _histSortAsc = false; }
                    _histShowAll = false;
                    renderHistogram(histogram, reachableHeapSize);
                });
            });

            var exportBtn = document.getElementById('export-csv-btn');
            if (exportBtn) {
                exportBtn.addEventListener('click', function() {
                    var csv = 'Class Name,Instances,Shallow Size,Retained Size,% of Heap\\n';
                    sorted.forEach(function(e) {
                        var pct = histogramPercentage(e.retained_size, reachableHeapSize);
                        csv += '"' + e.class_name.replace(/"/g, '""') + '",' + e.instance_count + ',' + e.shallow_size + ',' + e.retained_size + ',' + pct + '\\n';
                    });
                    vscode.postMessage({ command: 'exportHistogramCsv', csv: csv });
                });
            }

            // Delegated click handler for class name links
            container.querySelectorAll('.hist-class-link').forEach(function(link) {
                link.addEventListener('click', function() {
                    var className = link.dataset.class;
                    if (!className) return;
                    _pendingInstanceClass = className;
                    var panel = document.getElementById('histogram-instances-panel');
                    panel.innerHTML = '<div class="instance-panel"><div class="instance-panel-header"><span>Loading instances of ' + escapeHtml(className) + '...</span></div></div>';
                    var escapedClass = className.replace(/'/g, "''");
                    vscode.postMessage({ command: 'executeQuery', query: "SELECT * FROM instances WHERE class_name = \\'" + escapedClass + "\\' ORDER BY retained_size DESC LIMIT 200" });
                });
            });
        }

        // ---- Self-register ----
        onTabMessage('histogram', 'analysisComplete', function(msg) {
            // Lazy tab callbacks run before the orchestrator updates analysisData.
            renderHistogram(msg.classHistogram || [], msg.summary && msg.summary.reachable_heap_size);
        });

        function renderInstancePanel(className, result) {
            var panel = document.getElementById('histogram-instances-panel');
            if (!result || !result.rows || result.rows.length === 0) {
                panel.innerHTML = '<div class="instance-panel"><div class="instance-panel-header"><span>Instances of ' + escapeHtml(className) + ' (0)</span><button class="instance-panel-close">&times;</button></div><div style="padding:12px;opacity:0.5;font-size:12px;">No instances found</div></div>';
                panel.querySelector('.instance-panel-close').addEventListener('click', function() { panel.innerHTML = ''; _pendingInstanceClass = null; });
                return;
            }

            var cols = result.columns || [];
            var rows = result.rows || [];
            var totalRows = result.total_count || rows.length;
            var html = '<div class="instance-panel"><div class="instance-panel-header"><span>Instances of ' + escapeHtml(className) + ' (' + totalRows + ')</span><button class="instance-panel-close">&times;</button></div>';
            html += '<table><thead><tr>';
            cols.forEach(function(c) { html += '<th>' + escapeHtml(c) + '</th>'; });
            html += '<th>Actions</th></tr></thead><tbody>';

            rows.forEach(function(row) {
                html += '<tr>';
                var objId = 0;
                cols.forEach(function(c, ci) {
                    var val = row[ci];
                    if (c === 'object_id') objId = val;
                    if (c === 'shallow_size' || c === 'retained_size') {
                        html += '<td class="right">' + fmt(val) + '</td>';
                    } else {
                        html += '<td>' + escapeHtml(String(val)) + '</td>';
                    }
                });
                html += '<td class="instance-actions">';
                if (objId > 0) {
                    html += '<span class="tree-inspect instance-action" data-id="' + objId + '" data-class="' + escapeHtml(className) + '" title="Inspect">\\uD83D\\uDD0D</span>';
                    html += '<span class="tree-refs instance-action" data-id="' + objId + '" data-class="' + escapeHtml(className) + '" title="Show referrers">\\u2190</span>';
                    html += '<button class="why-alive-btn instance-action" data-id="' + objId + '" title="Why alive?" style="font-size:10px;padding:1px 4px;">Why alive?</button>';
                }
                html += '</td></tr>';
            });
            html += '</tbody></table>';

            if (rows.length < totalRows) {
                html += '<div style="text-align:center;padding:8px;font-size:11px;opacity:0.6;">Showing ' + rows.length + ' of ' + totalRows + ' \\u2014 use HeapQL for full results</div>';
            }

            if (result.execution_time_ms !== undefined) {
                html += '<div style="text-align:right;padding:4px 8px;font-size:10px;opacity:0.5;">' + rows.length + ' rows (' + result.execution_time_ms + 'ms)</div>';
            }

            html += '</div>';
            panel.innerHTML = html;

            panel.querySelector('.instance-panel-close').addEventListener('click', function() { panel.innerHTML = ''; _pendingInstanceClass = null; });

            panel.querySelectorAll('.tree-inspect.instance-action').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    openInspector(parseInt(btn.dataset.id), btn.dataset.class, 0, 0);
                });
            });

            panel.querySelectorAll('.tree-refs.instance-action').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var objId = parseInt(btn.dataset.id);
                    window._pendingRefsContext = { objectId: objId, className: btn.dataset.class };
                    vscode.postMessage({ command: 'getReferrers', objectId: objId });
                });
            });

            panel.querySelectorAll('.why-alive-btn.instance-action').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    vscode.postMessage({ command: 'gcRootPath', objectId: parseInt(btn.dataset.id) });
                });
            });
        }

        onMessage('queryResult', function(msg) {
            if (_pendingInstanceClass) {
                renderInstancePanel(_pendingInstanceClass, msg.result);
                _pendingInstanceClass = null;
                return true; // consumed
            }
            return false; // let query tab handle it
        });

        document.getElementById('histogram-search').addEventListener('input', function(e) {
            _histFilter = e.target.value;
            _histShowAll = false;
            if (analysisData) renderHistogram(analysisData.classHistogram || [], analysisData.summary && analysisData.summary.reachable_heap_size);
        });
    `;
}
