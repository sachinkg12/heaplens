export function getCompareJs(): string {
    return `
        // ---- Tab 8: Compare ----
        // Self-contained: owns DOM refs, dropdown, delta rendering, delta bar chart.

        var _compareSelect = document.getElementById('compare-select');
        var _compareBtn = document.getElementById('compare-btn');
        var _compareExportMdBtn = document.getElementById('compare-export-md-btn');
        var _compareExportCsvBtn = document.getElementById('compare-export-csv-btn');
        var _compareStatus = document.getElementById('compare-status');
        var _compareResults = document.getElementById('compare-results');
        var _savedBaseline = '';
        var _lastCompareResult = null;

        _compareSelect.addEventListener('change', function() {
            _savedBaseline = _compareSelect.value;
            _compareBtn.disabled = !_compareSelect.value;
        });

        _compareBtn.addEventListener('click', function() {
            if (!_compareSelect.value) return;
            _compareBtn.disabled = true;
            _compareStatus.className = 'compare-status';
            _compareStatus.textContent = 'Comparing...';
            _compareResults.innerHTML = '';
            vscode.postMessage({ command: 'compareHeaps', baselinePath: _compareSelect.value });
        });

        function populateBaselineDropdown(files) {
            _compareSelect.innerHTML = '<option value="">-- Select a baseline --</option>';
            files.forEach(function(f) {
                var opt = document.createElement('option');
                opt.value = f;
                var parts = f.replace(/\\\\\\\\/g, '/').split('/');
                opt.textContent = parts[parts.length - 1] + ' (' + f + ')';
                _compareSelect.appendChild(opt);
            });
            if (_savedBaseline && files.indexOf(_savedBaseline) !== -1) _compareSelect.value = _savedBaseline;
            _compareBtn.disabled = !_compareSelect.value;
            if (files.length === 0) {
                _compareStatus.className = 'compare-status';
                _compareStatus.textContent = 'No other analyzed files available. Open and analyze another .hprof file first.';
            } else {
                _compareStatus.textContent = '';
            }
        }

        function fmtDelta(bytes) {
            if (bytes === 0) return '0 B';
            var arrow = bytes > 0 ? '\\u2191' : '\\u2193';
            var sign = bytes > 0 ? '+' : '-';
            return arrow + sign + fmt(Math.abs(bytes));
        }

        function deltaClass(value) {
            if (value > 0) return 'delta-positive';
            if (value < 0) return 'delta-negative';
            return 'delta-zero';
        }

        function _compareStatCard(label, value, delta, isBytes, isPct) {
            var deltaStr;
            var arrow = delta > 0 ? '\\u2191' : (delta < 0 ? '\\u2193' : '');
            if (isPct) deltaStr = arrow + (delta >= 0 ? '+' : '') + delta.toFixed(1) + 'pp';
            else if (isBytes) deltaStr = fmtDelta(delta);
            else deltaStr = arrow + (delta >= 0 ? '+' : '') + fmtNum(delta);
            return '<div class="compare-stat-card">' +
                '<div class="label">' + escapeHtml(label) + '</div>' +
                '<div class="value">' + value + '</div>' +
                '<div class="delta ' + deltaClass(delta) + '">' + deltaStr + '</div></div>';
        }

        function _buildCompareHistTable(data, filter) {
            var rows = data;
            if (filter) {
                rows = data.filter(function(d) { return d.class_name.toLowerCase().indexOf(filter) !== -1; });
            }
            if (rows.length === 0) return '<div style="opacity:0.5; padding:12px;">No matching classes.</div>';

            var html = '<table><thead><tr>';
            html += '<th>Class</th><th>Change</th>';
            html += '<th class="right">Instances (\\u0394)</th>';
            html += '<th class="right">Shallow (\\u0394)</th>';
            html += '<th class="right">Retained (\\u0394)</th>';
            html += '<th class="right">Baseline Ret.</th>';
            html += '<th class="right">Current Ret.</th>';
            html += '</tr></thead><tbody>';

            rows.forEach(function(d) {
                html += '<tr>';
                html += '<td>' + escapeHtml(d.class_name) + '</td>';
                html += '<td><span class="change-badge ' + d.change_type + '">' + d.change_type + '</span></td>';
                var icArrow = d.instance_count_delta > 0 ? '\\u2191' : (d.instance_count_delta < 0 ? '\\u2193' : '');
                html += '<td class="right ' + deltaClass(d.instance_count_delta) + '">' + icArrow + (d.instance_count_delta >= 0 ? '+' : '') + fmtNum(d.instance_count_delta) + '</td>';
                html += '<td class="right ' + deltaClass(d.shallow_size_delta) + '">' + fmtDelta(d.shallow_size_delta) + '</td>';
                html += '<td class="right ' + deltaClass(d.retained_size_delta) + '">' + fmtDelta(d.retained_size_delta) + '</td>';
                html += '<td class="right">' + fmt(d.baseline_retained_size) + '</td>';
                html += '<td class="right">' + fmt(d.current_retained_size) + '</td>';
                html += '</tr>';
            });
            html += '</tbody></table>';
            return html;
        }

        function renderCompareResult(result) {
            _lastCompareResult = result;
            _compareBtn.disabled = false;
            _compareExportMdBtn.style.display = '';
            _compareExportCsvBtn.style.display = '';
            _compareStatus.className = 'compare-status';
            _compareStatus.textContent = '';

            var html = '';
            var sd = result.summary_delta;

            html += '<div class="compare-section-title">Summary Delta</div>';
            html += '<div class="stats-bar">';
            html += _compareStatCard('Total Heap', fmt(sd.current_total_heap_size), sd.total_heap_size_delta, true);
            html += _compareStatCard('Reachable', fmt(sd.current_reachable_heap_size), sd.reachable_heap_size_delta, true);
            html += _compareStatCard('Instances', fmtNum(sd.current_total_instances), sd.total_instances_delta, false);
            html += _compareStatCard('Classes', fmtNum(sd.current_total_classes), sd.total_classes_delta, false);
            html += _compareStatCard('Arrays', fmtNum(sd.current_total_arrays), sd.total_arrays_delta, false);
            html += _compareStatCard('GC Roots', fmtNum(sd.current_total_gc_roots), sd.total_gc_roots_delta, false);
            html += '</div>';

            var hd = result.histogram_delta || [];
            if (hd.length > 0) {
                html += '<div class="compare-section-title">Class Changes (' + hd.length + ' classes)</div>';
                html += '<input type="text" class="search-box" id="compare-hist-search" placeholder="Filter by class name...">';
                html += '<div id="compare-hist-table">' + _buildCompareHistTable(hd, '') + '</div>';
            }

            var lsc = result.leak_suspect_changes || [];
            if (lsc.length > 0) {
                html += '<div class="compare-section-title">Leak Suspect Changes</div>';
                lsc.forEach(function(l) {
                    html += '<div class="compare-leak-card ' + l.change_type + '">';
                    html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">';
                    html += '<span style="font-weight:bold; font-size:14px;">' + escapeHtml(l.class_name) + '</span>';
                    html += '<span class="change-badge ' + l.change_type + '">' + l.change_type + '</span></div>';
                    html += '<div style="font-size:13px; opacity:0.8; margin-bottom:4px;">' + escapeHtml(l.description) + '</div>';
                    if (l.change_type === 'persisted' || l.change_type === 'new') {
                        html += '<div style="font-size:12px; opacity:0.7;">';
                        if (l.baseline_retained_size > 0) html += 'Baseline: ' + fmt(l.baseline_retained_size) + ' (' + l.baseline_retained_percentage.toFixed(1) + '%) &rarr; ';
                        html += 'Current: ' + fmt(l.current_retained_size) + ' (' + l.current_retained_percentage.toFixed(1) + '%)';
                        if (l.retained_size_delta !== 0) html += ' <span class="' + deltaClass(l.retained_size_delta) + '">(' + fmtDelta(l.retained_size_delta) + ')</span>';
                        html += '</div>';
                    } else if (l.change_type === 'resolved') {
                        html += '<div style="font-size:12px; opacity:0.7;">Was: ' + fmt(l.baseline_retained_size) + ' (' + l.baseline_retained_percentage.toFixed(1) + '%)</div>';
                    }
                    html += '</div>';
                });
            }

            var wd = result.waste_delta;
            if (wd) {
                html += '<div class="compare-section-title">Waste Delta</div>';
                html += '<div class="stats-bar">';
                html += _compareStatCard('Total Waste', fmt(wd.current_total_wasted_bytes), wd.total_wasted_delta, true);
                html += _compareStatCard('Waste %', wd.current_waste_percentage.toFixed(1) + '%', wd.waste_percentage_delta, false, true);
                html += _compareStatCard('Dup. Strings', fmtDelta(wd.duplicate_string_wasted_delta), wd.duplicate_string_wasted_delta, false);
                html += _compareStatCard('Empty Colls.', fmtDelta(wd.empty_collection_wasted_delta), wd.empty_collection_wasted_delta, false);
                html += '</div>';
            }

            _compareResults.innerHTML = html;
            if (!wd) _compareResults.innerHTML += '<p class="scan-note">Waste delta: Not calculated. Calculate Waste for both snapshots and compare again.</p>';

            if (hd.length > 0) _renderCompareDeltaBars(hd);

            var histSearch = document.getElementById('compare-hist-search');
            if (histSearch) {
                histSearch.addEventListener('input', function() {
                    var filter = histSearch.value.toLowerCase();
                    var table = document.getElementById('compare-hist-table');
                    if (table) table.innerHTML = _buildCompareHistTable(hd, filter);
                });
            }
        }

        function renderCompareError(error) {
            _compareBtn.disabled = false;
            _compareStatus.className = 'compare-status error';
            _compareStatus.textContent = 'Error: ' + error;
        }

        function _renderCompareDeltaBars(histogramDelta) {
            if (typeof d3 === 'undefined' || !histogramDelta || histogramDelta.length === 0) return;

            var sorted = histogramDelta.slice().sort(function(a, b) {
                return Math.abs(b.retained_size_delta) - Math.abs(a.retained_size_delta);
            }).filter(function(d) { return d.retained_size_delta !== 0; }).slice(0, 10);
            if (sorted.length === 0) return;

            var container = document.getElementById('compare-delta-chart');
            if (!container) {
                container = document.createElement('div');
                container.id = 'compare-delta-chart';
                _compareResults.appendChild(container);
            }
            container.innerHTML = '';

            var titleDiv = document.createElement('div');
            titleDiv.className = 'compare-section-title';
            titleDiv.textContent = 'Top Changes by Retained Size';
            container.appendChild(titleDiv);

            var maxAbs = d3.max(sorted, function(d) { return Math.abs(d.retained_size_delta); }) || 1;
            var margin = { top: 10, right: 80, bottom: 10, left: 200 };
            var barH = 22, gap = 4;
            var w = 600, innerW = w - margin.left - margin.right;
            var h = sorted.length * (barH + gap) + margin.top + margin.bottom;

            var svg = d3.select(container).append('svg').attr('width', w).attr('height', h);
            var x = d3.scaleLinear().domain([-maxAbs, maxAbs]).range([0, innerW]);
            var center = x(0);
            var g = svg.append('g').attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

            g.append('line').attr('x1', center).attr('x2', center)
                .attr('y1', 0).attr('y2', sorted.length * (barH + gap))
                .attr('stroke', 'var(--vscode-panel-border)').attr('stroke-width', 1);

            sorted.forEach(function(item, i) {
                var y = i * (barH + gap);
                var shortName = item.class_name;
                var lastDot = shortName.lastIndexOf('.');
                if (lastDot !== -1) shortName = shortName.substring(lastDot + 1);
                if (shortName.length > 28) shortName = shortName.substring(0, 27) + '\\u2026';

                var delta = item.retained_size_delta;
                var barX = delta > 0 ? center : x(delta);
                var barW = Math.abs(x(delta) - center);
                var fillColor = delta > 0 ? 'var(--vscode-editorError-foreground, #f44)' : 'var(--vscode-testing-iconPassed, #388a34)';

                svg.append('text').attr('x', margin.left - 6).attr('y', margin.top + y + barH / 2 + 4)
                    .attr('text-anchor', 'end').attr('fill', 'var(--vscode-foreground)').attr('font-size', '11px').text(shortName);

                g.append('rect').attr('x', barX).attr('y', y).attr('width', Math.max(2, barW)).attr('height', barH)
                    .attr('fill', fillColor).attr('rx', 2).style('opacity', 0.8);

                var labelX = delta > 0 ? barX + barW + 4 : barX - 4;
                g.append('text').attr('x', labelX).attr('y', y + barH / 2 + 4)
                    .attr('text-anchor', delta > 0 ? 'start' : 'end')
                    .attr('fill', 'var(--vscode-foreground)').attr('font-size', '10px').style('opacity', 0.7).text(fmtDelta(delta));
            });
        }

        // ---- Export: Markdown report ----
        function _buildCompareMarkdown(r) {
            var sd = r.summary_delta;
            var lines = [];
            lines.push('# HeapLens Diff Report');
            lines.push('');
            lines.push('**Baseline:** ' + r.baseline_path);
            lines.push('**Current:** ' + r.current_path);
            lines.push('**Generated:** ' + new Date().toISOString());
            lines.push('');

            lines.push('## Summary Delta');
            lines.push('');
            lines.push('| Metric | Baseline | Current | Delta |');
            lines.push('|--------|----------|---------|-------|');
            lines.push('| Total Heap | ' + fmt(sd.baseline_total_heap_size) + ' | ' + fmt(sd.current_total_heap_size) + ' | ' + fmtDelta(sd.total_heap_size_delta) + ' |');
            lines.push('| Reachable | ' + fmt(sd.baseline_reachable_heap_size) + ' | ' + fmt(sd.current_reachable_heap_size) + ' | ' + fmtDelta(sd.reachable_heap_size_delta) + ' |');
            lines.push('| Instances | ' + fmtNum(sd.baseline_total_instances) + ' | ' + fmtNum(sd.current_total_instances) + ' | ' + (sd.total_instances_delta >= 0 ? '+' : '') + fmtNum(sd.total_instances_delta) + ' |');
            lines.push('| Classes | ' + fmtNum(sd.baseline_total_classes) + ' | ' + fmtNum(sd.current_total_classes) + ' | ' + (sd.total_classes_delta >= 0 ? '+' : '') + fmtNum(sd.total_classes_delta) + ' |');
            lines.push('| Arrays | ' + fmtNum(sd.baseline_total_arrays) + ' | ' + fmtNum(sd.current_total_arrays) + ' | ' + (sd.total_arrays_delta >= 0 ? '+' : '') + fmtNum(sd.total_arrays_delta) + ' |');
            lines.push('| GC Roots | ' + fmtNum(sd.baseline_total_gc_roots) + ' | ' + fmtNum(sd.current_total_gc_roots) + ' | ' + (sd.total_gc_roots_delta >= 0 ? '+' : '') + fmtNum(sd.total_gc_roots_delta) + ' |');
            lines.push('');

            var hd = r.histogram_delta || [];
            if (hd.length > 0) {
                var top = hd.slice(0, 30);
                lines.push('## Top Class Changes (by retained size delta)');
                lines.push('');
                lines.push('| Class | Change | Instances (\u0394) | Shallow (\u0394) | Retained (\u0394) | Baseline Ret. | Current Ret. |');
                lines.push('|-------|--------|----------------|---------------|----------------|---------------|--------------|');
                top.forEach(function(d) {
                    lines.push('| ' + d.class_name + ' | ' + d.change_type + ' | ' + (d.instance_count_delta >= 0 ? '+' : '') + fmtNum(d.instance_count_delta) + ' | ' + fmtDelta(d.shallow_size_delta) + ' | ' + fmtDelta(d.retained_size_delta) + ' | ' + fmt(d.baseline_retained_size) + ' | ' + fmt(d.current_retained_size) + ' |');
                });
                if (hd.length > 30) lines.push('');
                if (hd.length > 30) lines.push('*...and ' + (hd.length - 30) + ' more classes*');
                lines.push('');
            }

            var lsc = r.leak_suspect_changes || [];
            if (lsc.length > 0) {
                lines.push('## Leak Suspect Changes');
                lines.push('');
                lsc.forEach(function(l) {
                    var label = l.change_type === 'new' ? 'NEW' : (l.change_type === 'resolved' ? 'RESOLVED' : 'PERSISTED');
                    lines.push('- **[' + label + '] ' + l.class_name + '**');
                    lines.push('  ' + l.description);
                    if (l.change_type === 'persisted' || l.change_type === 'new') {
                        var detail = '';
                        if (l.baseline_retained_size > 0) detail += 'Baseline: ' + fmt(l.baseline_retained_size) + ' (' + l.baseline_retained_percentage.toFixed(1) + '%) -> ';
                        detail += 'Current: ' + fmt(l.current_retained_size) + ' (' + l.current_retained_percentage.toFixed(1) + '%)';
                        if (l.retained_size_delta !== 0) detail += ' (' + fmtDelta(l.retained_size_delta) + ')';
                        lines.push('  ' + detail);
                    } else if (l.change_type === 'resolved') {
                        lines.push('  Was: ' + fmt(l.baseline_retained_size) + ' (' + l.baseline_retained_percentage.toFixed(1) + '%)');
                    }
                });
                lines.push('');
            }

            var wd = r.waste_delta;
            if (wd) {
                lines.push('## Waste Delta');
                lines.push('');
                lines.push('| Metric | Delta |');
                lines.push('|--------|-------|');
                lines.push('| Total Waste | ' + fmtDelta(wd.total_wasted_delta) + ' |');
                lines.push('| Waste % | ' + (wd.waste_percentage_delta >= 0 ? '+' : '') + wd.waste_percentage_delta.toFixed(1) + 'pp |');
                lines.push('| Duplicate Strings | ' + fmtDelta(wd.duplicate_string_wasted_delta) + ' |');
                lines.push('| Empty Collections | ' + fmtDelta(wd.empty_collection_wasted_delta) + ' |');
                lines.push('');
            } else {
                lines.push('## Waste Delta', '', 'Not calculated for both snapshots.', '');
            }

            return lines.join('\\n');
        }

        // ---- Export: CSV ----
        function _buildCompareCsv(r) {
            var hd = r.histogram_delta || [];
            var lines = ['Class,Change Type,Instance Count Delta,Shallow Size Delta,Retained Size Delta,Baseline Instances,Baseline Shallow,Baseline Retained,Current Instances,Current Shallow,Current Retained'];
            hd.forEach(function(d) {
                var name = d.class_name.indexOf(',') !== -1 ? '"' + d.class_name + '"' : d.class_name;
                lines.push([name, d.change_type, d.instance_count_delta, d.shallow_size_delta, d.retained_size_delta, d.baseline_instance_count, d.baseline_shallow_size, d.baseline_retained_size, d.current_instance_count, d.current_shallow_size, d.current_retained_size].join(','));
            });
            return lines.join('\\n');
        }

        _compareExportMdBtn.addEventListener('click', function() {
            if (!_lastCompareResult) return;
            vscode.postMessage({ command: 'exportCompareMarkdown', markdown: _buildCompareMarkdown(_lastCompareResult) });
        });

        _compareExportCsvBtn.addEventListener('click', function() {
            if (!_lastCompareResult) return;
            vscode.postMessage({ command: 'exportCompareCsv', csv: _buildCompareCsv(_lastCompareResult) });
        });

        // ---- Self-register ----
        onMessage('analyzedFiles', function(msg) {
            populateBaselineDropdown(msg.files || []);
        });

        onMessage('compareResult', function(msg) {
            renderCompareResult(msg.result);
        });

        onMessage('compareError', function(msg) {
            renderCompareError(msg.error);
        });

        onMessage('compareReportCopied', function() {
            _compareStatus.className = 'compare-status';
            _compareStatus.textContent = 'Diff report copied to clipboard!';
            setTimeout(function() { _compareStatus.textContent = ''; }, 3000);
        });

        onTabActivate('compare', function() {
            vscode.postMessage({ command: 'listAnalyzedFiles' });
        });
    `;
}
