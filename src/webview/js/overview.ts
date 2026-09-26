export function getOverviewJs(): string {
    return `
        // ---- Tab 1: Overview ----
        // Self-contained: owns its render functions + diagnosis + report button.

        function renderOverview(data) {
            var s = data.summary;
            if (s) {
                var statsHtml = [
                    { label: 'Reachable Heap', value: fmt(s.reachable_heap_size || s.total_heap_size) },
                    { label: 'Total Heap', value: fmt(s.total_heap_size) },
                    { label: 'Objects', value: fmtNum(s.total_instances) },
                    { label: 'Classes', value: fmtNum(s.total_classes) },
                    { label: 'Arrays', value: fmtNum(s.total_arrays) },
                    { label: 'GC Roots', value: fmtNum(s.total_gc_roots) }
                ].map(function(c) { return '<div class="stat-card"><div class="label">' + c.label + '</div><div class="value">' + c.value + '</div></div>'; }).join('');

                if (s.size_model && s.size_model.estimated) {
                    statsHtml += '<div class="stat-card" title="Byte sizes are estimates; see the shallow-size documentation for model assumptions."><div class="label">Size model</div><div class="value">' + (s.size_model.name === 'legacy-payload-v0' ? 'Payload-only estimate' : 'JVM layout estimate') + '</div></div>';
                }

                // Platform badge
                var isAndroid = s.hprof_version && s.hprof_version.indexOf('1.0.3') !== -1;
                if (isAndroid) {
                    statsHtml += '<div class="stat-card"><div class="label">Platform</div><div class="value"><span class="android-badge">Android (ART)</span></div></div>';
                }

                // Heap type chips (Android heap regions)
                if (s.heap_types && s.heap_types.length > 0) {
                    var chips = s.heap_types.map(function(t) { return '<span class="heap-type-chip">' + escapeHtml(t) + '</span>'; }).join(' ');
                    statsHtml += '<div class="stat-card"><div class="label">Heap Regions</div><div class="value">' + chips + '</div></div>';
                }

                document.getElementById('stats-bar').innerHTML = statsHtml;
            }

            var objs = (data.topObjects || []).filter(function(o) { return o.node_type !== 'Class' && o.node_type !== 'SuperRoot' && o.retained_size > 0; }).slice(0, 10);
            var html = '<table><thead><tr><th>#</th><th>Class</th><th>Type</th><th class="right">Shallow</th><th class="right">Retained</th><th></th></tr></thead><tbody>';
            objs.forEach(function(o, i) {
                var whyBtn = o.object_id ? '<button class="why-alive-btn" data-object-id="' + o.object_id + '">Why alive?</button>' : '';
                html += '<tr><td>' + (i+1) + '</td><td>' + escapeHtml(o.class_name || o.node_type) + '</td><td>' + o.node_type + '</td><td class="right">' + fmt(o.shallow_size) + '</td><td class="right">' + fmt(o.retained_size) + '</td><td>' + whyBtn + '</td></tr>';
            });
            html += '</tbody></table>';
            var topTable = document.getElementById('top-objects-table');
            topTable.innerHTML = html;
            topTable.querySelectorAll('.why-alive-btn').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    vscode.postMessage({ command: 'gcRootPath', objectId: parseInt(btn.dataset.objectId, 10) });
                });
            });

            renderTreemap(objs);
            renderBarChart(objs);

            document.getElementById('report-actions').style.display = 'block';
            renderDiagnosis(data);
        }

        function renderTreemap(objs) {
            if (typeof d3 === 'undefined' || objs.length === 0) return;
            var container = document.getElementById('pie-chart');
            container.innerHTML = '';
            var w = container.clientWidth || 500, h = 350;

            var svg = d3.select(container).append('svg').attr('width', w).attr('height', h);
            var color = d3.scaleOrdinal(d3.schemeTableau10);

            var rootData = {
                name: 'heap',
                children: objs.map(function(o, i) {
                    return { name: (o.class_name || o.node_type), value: o.retained_size, index: i };
                })
            };

            var root = d3.hierarchy(rootData).sum(function(d) { return d.value; }).sort(function(a, b) { return b.value - a.value; });
            d3.treemap().size([w, h]).padding(2).round(true)(root);

            var cells = svg.selectAll('g').data(root.leaves()).enter().append('g')
                .attr('transform', function(d) { return 'translate(' + d.x0 + ',' + d.y0 + ')'; });

            cells.append('rect')
                .attr('width', function(d) { return d.x1 - d.x0; })
                .attr('height', function(d) { return d.y1 - d.y0; })
                .attr('fill', function(d) { return color(d.data.index); })
                .attr('stroke', 'var(--vscode-editor-background)')
                .attr('stroke-width', 1)
                .style('opacity', 0.85);

            cells.each(function(d) {
                var cellW = d.x1 - d.x0;
                var cellH = d.y1 - d.y0;
                var g = d3.select(this);

                if (cellW > 60 && cellH > 30) {
                    var shortName = d.data.name;
                    var lastDot = shortName.lastIndexOf('.');
                    if (lastDot !== -1) shortName = shortName.substring(lastDot + 1);
                    if (shortName.length > Math.floor(cellW / 7)) {
                        shortName = shortName.substring(0, Math.floor(cellW / 7) - 1) + '\\u2026';
                    }

                    g.append('text').attr('x', 4).attr('y', 14).text(shortName)
                        .attr('fill', '#fff').attr('font-size', '11px').attr('font-weight', 'bold')
                        .style('pointer-events', 'none').style('text-shadow', '0 1px 2px rgba(0,0,0,0.5)');

                    if (cellH > 44) {
                        g.append('text').attr('x', 4).attr('y', 28).text(fmt(d.data.value))
                            .attr('fill', '#fff').attr('font-size', '10px').style('opacity', 0.8)
                            .style('pointer-events', 'none').style('text-shadow', '0 1px 2px rgba(0,0,0,0.5)');
                    }
                }
            });

            cells.append('title').text(function(d) { return d.data.name + ': ' + fmt(d.data.value); });
        }

        function renderBarChart(objs) {
            if (typeof d3 === 'undefined' || objs.length === 0) return;
            var container = document.getElementById('bar-chart');
            container.innerHTML = '';

            var items = objs.slice(0, 10);
            var maxVal = d3.max(items, function(d) { return d.retained_size; }) || 1;
            var margin = { top: 10, right: 80, bottom: 10, left: 200 };
            var barH = 22, gap = 4;
            var w = container.clientWidth || 500, h = items.length * (barH + gap) + margin.top + margin.bottom;

            var titleDiv = document.createElement('div');
            titleDiv.className = 'section-title';
            titleDiv.textContent = 'Top 10 by Retained Size';
            container.appendChild(titleDiv);

            var svg = d3.select(container).append('svg').attr('width', w).attr('height', h);
            var color = d3.scaleOrdinal(d3.schemeTableau10);
            var x = d3.scaleLinear().domain([0, maxVal]).range([0, w - margin.left - margin.right]);
            var g = svg.append('g').attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

            items.forEach(function(item, i) {
                var y = i * (barH + gap);
                var shortName = item.class_name || item.node_type;
                var lastDot = shortName.lastIndexOf('.');
                if (lastDot !== -1) shortName = shortName.substring(lastDot + 1);
                if (shortName.length > 28) shortName = shortName.substring(0, 27) + '\\u2026';

                svg.append('text').attr('x', margin.left - 6).attr('y', margin.top + y + barH / 2 + 4)
                    .attr('text-anchor', 'end').attr('fill', 'var(--vscode-foreground)').attr('font-size', '11px').text(shortName);

                g.append('rect').attr('x', 0).attr('y', y)
                    .attr('width', Math.max(2, x(item.retained_size))).attr('height', barH)
                    .attr('fill', color(i)).attr('rx', 2).style('opacity', 0.85);

                g.append('text').attr('x', Math.max(2, x(item.retained_size)) + 4).attr('y', y + barH / 2 + 4)
                    .attr('fill', 'var(--vscode-foreground)').attr('font-size', '10px').style('opacity', 0.7).text(fmt(item.retained_size));
            });
        }

        function showReportCopied() {
            var el = document.getElementById('report-copied');
            el.classList.add('visible');
            setTimeout(function() { el.classList.remove('visible'); }, 3000);
        }

        function getRecommendation(className, severity) {
            var cn = className.toLowerCase();
            if (cn.indexOf('cache') !== -1 || cn.indexOf('cach') !== -1) {
                return severity === 'critical'
                    ? 'Cache is consuming excessive memory. Check eviction policy, consider bounded caches (LRU/LFU), or reduce max size.'
                    : 'Review cache eviction settings and TTL configuration.';
            }
            if (cn.indexOf('pool') !== -1 || cn.indexOf('connection') !== -1 || cn.indexOf('datasource') !== -1) {
                return 'Check for connection leaks. Ensure connections are closed after use. Review pool max size and idle timeout settings.';
            }
            if (cn.indexOf('session') !== -1 || cn.indexOf('httpsession') !== -1) {
                return 'Check session timeout settings. Look for session attributes storing large objects. Consider session size limits.';
            }
            if (cn.indexOf('queue') !== -1 || cn.indexOf('buffer') !== -1 || cn.indexOf('blocking') !== -1) {
                return 'Possible backpressure issue. Check consumer throughput, queue capacity limits, and producer rate.';
            }
            if (cn.indexOf('thread') !== -1) {
                return 'Check for thread pool exhaustion or thread-local leaks. Review pool sizing.';
            }
            if (cn === 'byte[]' || cn === 'char[]') {
                return severity === 'critical'
                    ? 'Large byte/char arrays suggest buffering or serialization issues. Check for unclosed streams, large response bodies, or excessive string operations.'
                    : 'Review buffer sizes and ensure streams are properly closed.';
            }
            if (severity === 'critical') {
                return 'This class retains a very large portion of the heap. Investigate why these objects are not being garbage collected.';
            }
            return 'Consider if the number of instances and retained size are expected for your application workload.';
        }

        function renderDiagnosis(data) {
            var section = document.getElementById('diagnosis-section');
            if (!data.summary || !data.classHistogram) { section.innerHTML = ''; return; }

            var totalHeap = data.summary.reachable_heap_size || data.summary.total_heap_size;
            if (totalHeap === 0) { section.innerHTML = ''; return; }

            var findings = [];
            var suspects = data.leakSuspects || [];
            suspects.forEach(function(s) {
                if (s.retained_percentage > 50) {
                    findings.push({ severity: 'critical', confidence: 'high', title: s.class_name + ' retains ' + s.retained_percentage.toFixed(1) + '% of heap', detail: getRecommendation(s.class_name, 'critical') });
                } else if (s.retained_percentage > 20) {
                    findings.push({ severity: 'warning', confidence: 'high', title: s.class_name + ' retains ' + s.retained_percentage.toFixed(1) + '% of heap', detail: getRecommendation(s.class_name, 'warning') });
                }
            });

            var histogram = data.classHistogram || [];
            histogram.forEach(function(entry) {
                var pct = (entry.retained_size / totalHeap) * 100;
                var cn = entry.class_name;
                var cnLower = cn.toLowerCase();

                if ((cn === 'byte[]' || cn === 'char[]') && pct > 20) {
                    if (!findings.some(function(f) { return f.title.indexOf(cn) !== -1; })) {
                        findings.push({ severity: 'warning', confidence: 'medium', title: cn + ' occupies ' + pct.toFixed(1) + '% of heap', detail: getRecommendation(cn, 'warning') });
                    }
                }

                if (pct > 10) {
                    ['cache', 'pool', 'connection', 'session', 'queue', 'buffer'].forEach(function(pat) {
                        if (cnLower.indexOf(pat) !== -1 && !findings.some(function(f) { return f.title.indexOf(cn) !== -1; })) {
                            findings.push({ severity: pct > 30 ? 'critical' : 'warning', confidence: 'medium', title: cn + ' pattern detected (' + pct.toFixed(1) + '% heap)', detail: getRecommendation(cn, pct > 30 ? 'critical' : 'warning') });
                        }
                    });
                }

                if (entry.instance_count > 100000 && pct > 3) {
                    if (!findings.some(function(f) { return f.title.indexOf(cn) !== -1; })) {
                        findings.push({ severity: 'info', confidence: 'low', title: fmtNum(entry.instance_count) + ' instances of ' + cn + ' (' + pct.toFixed(1) + '% heap)', detail: 'High instance count may indicate object accumulation. Check if objects are being properly released.' });
                    }
                }
            });

            var order = { critical: 0, warning: 1, info: 2 };
            findings.sort(function(a, b) { return order[a.severity] - order[b.severity]; });

            if (findings.length === 0) { section.innerHTML = ''; return; }

            var severityIcons = { critical: '\\u26D4', warning: '\\u26A0', info: '\\u2139' };
            var html = '<div class="section-title">Quick Checks</div>';
            findings.forEach(function(f) {
                var icon = severityIcons[f.severity] || '';
                html += '<div class="diagnosis-card ' + f.severity + '">' +
                    '<div class="diagnosis-severity">' + icon + ' ' + f.severity.toUpperCase() +
                    ' <span class="diagnosis-confidence ' + f.confidence + '">' + f.confidence + '</span></div>' +
                    '<div class="diagnosis-title">' + escapeHtml(f.title) + '</div>' +
                    '<div class="diagnosis-detail">' + escapeHtml(f.detail) + '</div>' +
                    '</div>';
            });
            section.innerHTML = html;
        }

        // ---- Responsive chart resize ----
        var _overviewLastObjs = null;
        var _overviewResizeTimer = null;

        function _overviewOnResize() {
            if (_overviewResizeTimer) clearTimeout(_overviewResizeTimer);
            _overviewResizeTimer = setTimeout(function() {
                _overviewResizeTimer = null;
                if (_overviewLastObjs && _overviewLastObjs.length > 0) {
                    renderTreemap(_overviewLastObjs);
                    renderBarChart(_overviewLastObjs);
                }
            }, 100);
        }

        if (typeof ResizeObserver !== 'undefined') {
            var _chartObserver = new ResizeObserver(_overviewOnResize);
            var _pieEl = document.getElementById('pie-chart');
            var _barEl = document.getElementById('bar-chart');
            if (_pieEl) _chartObserver.observe(_pieEl);
            if (_barEl) _chartObserver.observe(_barEl);
        }

        // ---- Self-register ----
        // Partial progress: show summary stats immediately after graph building,
        // before dominator tree computation completes.
        onMessage('analysisProgress', function(msg) {
            var s = msg.summary;
            if (!s) return;
            var progressHtml = [
                { label: 'Reachable Heap', value: fmt(s.reachable_heap_size || s.total_heap_size) },
                { label: 'Total Heap', value: fmt(s.total_heap_size) },
                { label: 'Objects', value: fmtNum(s.total_instances) },
                { label: 'Classes', value: fmtNum(s.total_classes) },
                { label: 'Arrays', value: fmtNum(s.total_arrays) },
                { label: 'GC Roots', value: fmtNum(s.total_gc_roots) }
            ].map(function(c) { return '<div class="stat-card"><div class="label">' + c.label + '</div><div class="value">' + c.value + '</div></div>'; }).join('');

            if (s.size_model && s.size_model.estimated) {
                progressHtml += '<div class="stat-card"><div class="label">Size model</div><div class="value">' + (s.size_model.name === 'legacy-payload-v0' ? 'Payload-only estimate' : 'JVM layout estimate') + '</div></div>';
            }
            var isAndroidP = s.hprof_version && s.hprof_version.indexOf('1.0.3') !== -1;
            if (isAndroidP) {
                progressHtml += '<div class="stat-card"><div class="label">Platform</div><div class="value"><span class="android-badge">Android (ART)</span></div></div>';
            }

            document.getElementById('stats-bar').innerHTML = progressHtml;
        });

        onMessage('analysisComplete', function(msg) {
            renderOverview(msg);
            // Cache filtered objects for resize re-renders
            _overviewLastObjs = (msg.topObjects || []).filter(function(o) { return o.node_type !== 'Class' && o.node_type !== 'SuperRoot' && o.retained_size > 0; }).slice(0, 10);
        });

        onMessage('reportCopied', function() {
            showReportCopied();
        });

        document.getElementById('copy-report-btn').addEventListener('click', function() {
            vscode.postMessage({ command: 'copyReport' });
        });
    `;
}
