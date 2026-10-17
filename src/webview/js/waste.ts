export function getWasteJs(): string {
    return `
        // ---- Tab 5: Waste ----
        // Owns waste data, sorting, filtering, and rendering with totals.

        var _wasteData = null;
        var _wasteReady = false, _wasteRequest = null, _wasteSequence = 0;
        var _wasteFilter = '';
        var _wasteSortCol = { dup: 'wasted_bytes', empty: 'wasted_bytes', overalloc: 'wasted_bytes', boxed: 'wasted_bytes' };
        var _wasteSortAsc = { dup: false, empty: false, overalloc: false, boxed: false };

        function renderWaste(wasteAnalysis) {
            _wasteData = wasteAnalysis;
            _wasteFilter = '';
            var searchBox = document.getElementById('waste-search');
            if (searchBox) searchBox.value = '';

            var summaryBar = document.getElementById('waste-summary-bar');
            if (!wasteAnalysis) {
                summaryBar.innerHTML = '<p class="scan-note">Waste: Not calculated. Content analysis runs only when requested.</p><button class="btn" id="calculate-waste-btn"' + (!_wasteReady || _wasteRequest ? ' disabled' : '') + '>' + (_wasteRequest ? 'Calculating Waste…' : 'Calculate Waste') + '</button>';
                ['waste-dup-table','waste-empty-table','waste-overalloc-table','waste-boxed-table'].forEach(function(id) { var el=document.getElementById(id); if(el)el.textContent=''; });
                ['waste-dup-title','waste-empty-title','waste-overalloc-title','waste-boxed-title'].forEach(function(id) { var el=document.getElementById(id); if(el)el.style.display='none'; });
                return;
            }

            var w = wasteAnalysis;
            var cards = [
                { label: 'Total Waste', value: fmt(w.total_wasted_bytes), highlight: w.waste_percentage > 5 },
                { label: '% of Heap', value: w.waste_percentage.toFixed(1) + '%', highlight: w.waste_percentage > 10 },
                { label: 'Dup Strings', value: fmt(w.duplicate_string_wasted_bytes), highlight: false },
                { label: 'Empty Collections', value: fmt(w.empty_collection_wasted_bytes), highlight: false }
            ];
            if (w.over_allocated_wasted_bytes > 0) {
                cards.push({ label: 'Over-Allocated', value: fmt(w.over_allocated_wasted_bytes), highlight: false });
            }
            if (w.boxed_primitive_wasted_bytes > 0) {
                cards.push({ label: 'Boxed Primitives', value: fmt(w.boxed_primitive_wasted_bytes), highlight: false });
            }
            summaryBar.innerHTML = cards.map(function(c) {
                return '<div class="waste-stat-card"><div class="label">' + c.label + '</div><div class="value' + (c.highlight ? ' highlight' : '') + '">' + (c.highlight ? '\\u26A0 ' : '') + c.value + '</div></div>';
            }).join('');

            renderDupTable();
            renderEmptyTable();
            renderOverallocTable();
            renderBoxedTable();
        }

        function _sortWasteData(arr, col, asc) {
            return arr.slice().sort(function(a, b) {
                var va = a[col], vb = b[col];
                if (typeof va === 'string') return asc ? va.localeCompare(vb) : vb.localeCompare(va);
                return asc ? va - vb : vb - va;
            });
        }

        function _filterWaste(arr, key) {
            if (!_wasteFilter) return arr;
            var f = _wasteFilter.toLowerCase();
            return arr.filter(function(d) {
                var val = d[key] || '';
                return val.toLowerCase().indexOf(f) !== -1;
            });
        }

        function renderDupTable() {
            if (!_wasteData) return;
            var dupTitle = document.getElementById('waste-dup-title');
            var dupTable = document.getElementById('waste-dup-table');
            var dups = _wasteData.duplicate_strings || [];
            dups = _filterWaste(dups, 'preview');
            dups = _sortWasteData(dups, _wasteSortCol.dup, _wasteSortAsc.dup);

            if (dups.length === 0 && !_wasteFilter) {
                dupTitle.style.display = 'none';
                dupTable.innerHTML = '';
                return;
            }
            dupTitle.style.display = 'block';
            var sortArrow = function(col) {
                return _wasteSortCol.dup === col ? ' <span class="sort-arrow">' + (_wasteSortAsc.dup ? '\\u25B2' : '\\u25BC') + '</span>' : '';
            };
            var html = '<table><thead><tr>' +
                '<th data-sort="preview" data-category="dup">Preview' + sortArrow('preview') + '</th>' +
                '<th class="right" data-sort="count" data-category="dup">Copies' + sortArrow('count') + '</th>' +
                '<th class="right" data-sort="wasted_bytes" data-category="dup">Wasted' + sortArrow('wasted_bytes') + '</th>' +
                '<th class="right" data-sort="total_bytes" data-category="dup">Total' + sortArrow('total_bytes') + '</th>' +
                '</tr></thead><tbody>';
            var totalCount = 0, totalWasted = 0, totalTotal = 0;
            dups.forEach(function(d) {
                var preview = d.preview || '(empty)';
                totalCount += d.count;
                totalWasted += d.wasted_bytes;
                totalTotal += d.total_bytes;
                html += '<tr><td><span class="waste-preview" title="' + escapeHtml(preview) + '">' + escapeHtml(preview) + '</span></td>'
                    + '<td class="right">' + fmtNum(d.count) + '</td>'
                    + '<td class="right">' + fmt(d.wasted_bytes) + '</td>'
                    + '<td class="right">' + fmt(d.total_bytes) + '</td></tr>';
            });
            html += '</tbody><tfoot><tr class="waste-totals-row">' +
                '<td><strong>Total (' + dups.length + ')</strong></td>' +
                '<td class="right"><strong>' + fmtNum(totalCount) + '</strong></td>' +
                '<td class="right"><strong>' + fmt(totalWasted) + '</strong></td>' +
                '<td class="right"><strong>' + fmt(totalTotal) + '</strong></td>' +
                '</tr></tfoot></table>';
            dupTable.innerHTML = html;
        }

        function renderEmptyTable() {
            if (!_wasteData) return;
            var emptyTitle = document.getElementById('waste-empty-title');
            var emptyTable = document.getElementById('waste-empty-table');
            var empties = _wasteData.empty_collections || [];
            empties = _filterWaste(empties, 'class_name');
            empties = _sortWasteData(empties, _wasteSortCol.empty, _wasteSortAsc.empty);

            if (empties.length === 0 && !_wasteFilter) {
                emptyTitle.style.display = 'none';
                emptyTable.innerHTML = '';
                return;
            }
            emptyTitle.style.display = 'block';
            var sortArrow = function(col) {
                return _wasteSortCol.empty === col ? ' <span class="sort-arrow">' + (_wasteSortAsc.empty ? '\\u25B2' : '\\u25BC') + '</span>' : '';
            };
            var html = '<table><thead><tr>' +
                '<th data-sort="class_name" data-category="empty">Class' + sortArrow('class_name') + '</th>' +
                '<th class="right" data-sort="count" data-category="empty">Count' + sortArrow('count') + '</th>' +
                '<th class="right" data-sort="wasted_bytes" data-category="empty">Wasted' + sortArrow('wasted_bytes') + '</th>' +
                '</tr></thead><tbody>';
            var totalCount = 0, totalWasted = 0;
            empties.forEach(function(e) {
                totalCount += e.count;
                totalWasted += e.wasted_bytes;
                html += '<tr><td>' + escapeHtml(e.class_name) + '</td>'
                    + '<td class="right">' + fmtNum(e.count) + '</td>'
                    + '<td class="right">' + fmt(e.wasted_bytes) + '</td></tr>';
            });
            html += '</tbody><tfoot><tr class="waste-totals-row">' +
                '<td><strong>Total (' + empties.length + ')</strong></td>' +
                '<td class="right"><strong>' + fmtNum(totalCount) + '</strong></td>' +
                '<td class="right"><strong>' + fmt(totalWasted) + '</strong></td>' +
                '</tr></tfoot></table>';
            emptyTable.innerHTML = html;
        }

        function renderOverallocTable() {
            if (!_wasteData) return;
            var overallocTitle = document.getElementById('waste-overalloc-title');
            var overallocTable = document.getElementById('waste-overalloc-table');
            var overallocs = _wasteData.over_allocated_collections || [];
            overallocs = _filterWaste(overallocs, 'class_name');
            overallocs = _sortWasteData(overallocs, _wasteSortCol.overalloc, _wasteSortAsc.overalloc);

            if (overallocs.length === 0 && !_wasteFilter) {
                overallocTitle.style.display = 'none';
                overallocTable.innerHTML = '';
                return;
            }
            overallocTitle.style.display = 'block';
            var sortArrow = function(col) {
                return _wasteSortCol.overalloc === col ? ' <span class="sort-arrow">' + (_wasteSortAsc.overalloc ? '\\u25B2' : '\\u25BC') + '</span>' : '';
            };
            var html = '<table><thead><tr>' +
                '<th data-sort="class_name" data-category="overalloc">Class' + sortArrow('class_name') + '</th>' +
                '<th class="right" data-sort="count" data-category="overalloc">Count' + sortArrow('count') + '</th>' +
                '<th class="right" data-sort="wasted_bytes" data-category="overalloc">Wasted' + sortArrow('wasted_bytes') + '</th>' +
                '<th class="right" data-sort="avg_fill_ratio" data-category="overalloc">Avg Fill %' + sortArrow('avg_fill_ratio') + '</th>' +
                '</tr></thead><tbody>';
            var totalCount = 0, totalWasted = 0, weightedFill = 0;
            overallocs.forEach(function(o) {
                totalCount += o.count;
                totalWasted += o.wasted_bytes;
                weightedFill += o.avg_fill_ratio * o.count;
                html += '<tr><td>' + escapeHtml(o.class_name) + '</td>'
                    + '<td class="right">' + fmtNum(o.count) + '</td>'
                    + '<td class="right">' + fmt(o.wasted_bytes) + '</td>'
                    + '<td class="right">' + o.avg_fill_ratio.toFixed(1) + '%</td></tr>';
            });
            var avgFill = totalCount > 0 ? (weightedFill / totalCount).toFixed(1) : '0.0';
            html += '</tbody><tfoot><tr class="waste-totals-row">' +
                '<td><strong>Total (' + overallocs.length + ')</strong></td>' +
                '<td class="right"><strong>' + fmtNum(totalCount) + '</strong></td>' +
                '<td class="right"><strong>' + fmt(totalWasted) + '</strong></td>' +
                '<td class="right"><strong>' + avgFill + '%</strong></td>' +
                '</tr></tfoot></table>';
            overallocTable.innerHTML = html;
        }

        function renderBoxedTable() {
            if (!_wasteData) return;
            var boxedTitle = document.getElementById('waste-boxed-title');
            var boxedTable = document.getElementById('waste-boxed-table');
            var boxed = _wasteData.boxed_primitives || [];
            boxed = _filterWaste(boxed, 'class_name');
            boxed = _sortWasteData(boxed, _wasteSortCol.boxed, _wasteSortAsc.boxed);

            if (boxed.length === 0 && !_wasteFilter) {
                boxedTitle.style.display = 'none';
                boxedTable.innerHTML = '';
                return;
            }
            boxedTitle.style.display = 'block';
            var sortArrow = function(col) {
                return _wasteSortCol.boxed === col ? ' <span class="sort-arrow">' + (_wasteSortAsc.boxed ? '\\u25B2' : '\\u25BC') + '</span>' : '';
            };
            var html = '<table><thead><tr>' +
                '<th data-sort="class_name" data-category="boxed">Class' + sortArrow('class_name') + '</th>' +
                '<th class="right" data-sort="count" data-category="boxed">Count' + sortArrow('count') + '</th>' +
                '<th class="right" data-sort="wasted_bytes" data-category="boxed">Wasted' + sortArrow('wasted_bytes') + '</th>' +
                '<th class="right" data-sort="unboxed_size" data-category="boxed">Unboxed Size' + sortArrow('unboxed_size') + '</th>' +
                '</tr></thead><tbody>';
            var totalCount = 0, totalWasted = 0, totalUnboxed = 0;
            boxed.forEach(function(b) {
                totalCount += b.count;
                totalWasted += b.wasted_bytes;
                totalUnboxed += b.unboxed_size;
                html += '<tr><td>' + escapeHtml(b.class_name) + '</td>'
                    + '<td class="right">' + fmtNum(b.count) + '</td>'
                    + '<td class="right">' + fmt(b.wasted_bytes) + '</td>'
                    + '<td class="right">' + fmt(b.unboxed_size) + '</td></tr>';
            });
            html += '</tbody><tfoot><tr class="waste-totals-row">' +
                '<td><strong>Total (' + boxed.length + ')</strong></td>' +
                '<td class="right"><strong>' + fmtNum(totalCount) + '</strong></td>' +
                '<td class="right"><strong>' + fmt(totalWasted) + '</strong></td>' +
                '<td class="right"><strong>' + fmt(totalUnboxed) + '</strong></td>' +
                '</tr></tfoot></table>';
            boxedTable.innerHTML = html;
        }

        // Delegated sort click handler for waste tables
        document.getElementById('tab-waste').addEventListener('click', function(e) {
            if (e.target.closest('#calculate-waste-btn')) {
                if (!_wasteReady || _wasteRequest) return;
                _wasteRequest = 'waste-' + (++_wasteSequence);
                renderWaste(null);
                vscode.postMessage({ command: 'calculateWaste', requestId: _wasteRequest });
                return;
            }
            var th = e.target.closest('th[data-sort]');
            if (!th) return;
            var col = th.dataset.sort;
            var cat = th.dataset.category;
            if (!col || !cat) return;
            if (_wasteSortCol[cat] === col) {
                _wasteSortAsc[cat] = !_wasteSortAsc[cat];
            } else {
                _wasteSortCol[cat] = col;
                _wasteSortAsc[cat] = col === 'class_name' || col === 'preview';
            }
            if (cat === 'dup') renderDupTable();
            else if (cat === 'empty') renderEmptyTable();
            else if (cat === 'overalloc') renderOverallocTable();
            else if (cat === 'boxed') renderBoxedTable();
        });

        // Filter handler
        var _wasteSearchBox = document.getElementById('waste-search');
        if (_wasteSearchBox) {
            _wasteSearchBox.addEventListener('input', function() {
                _wasteFilter = _wasteSearchBox.value.toLowerCase();
                renderDupTable();
                renderEmptyTable();
                renderOverallocTable();
                renderBoxedTable();
            });
        }

        // ---- Self-register ----
        onTabMessage('waste', 'analysisComplete', function(msg) {
            _wasteReady = true; _wasteRequest = null;
            renderWaste(msg.wasteAnalysis);
        });
        onMessage('wasteResult', function(msg) {
            if (msg.requestId !== _wasteRequest || !msg.wasteAnalysis) return;
            _wasteRequest = null;
            if (_analysisMsg) _analysisMsg.wasteAnalysis = msg.wasteAnalysis;
            if (analysisData) analysisData.wasteAnalysis = msg.wasteAnalysis;
            renderWaste(msg.wasteAnalysis);
        });
        onMessage('wasteError', function(msg) {
            if (msg.requestId !== _wasteRequest) return;
            _wasteRequest = null; renderWaste(null);
            var note=document.createElement('p');note.className='scan-note';
            note.textContent=msg.error || 'Waste analysis failed. Retry Calculate Waste.';
            document.getElementById('waste-summary-bar').appendChild(note);
        });
        ['analysisStarting','shallowScanComplete','analysisCancelled','analysisFailed','serverCrashed'].forEach(function(command) {
            onMessage(command,function(){_wasteReady=false;_wasteRequest=null;renderWaste(null);});
        });
    `;
}
