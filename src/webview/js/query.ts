export function getQueryJs(): string {
    return `
        // ---- Tab 7: Query ----
        // Self-contained: owns query history, DOM refs, result rendering,
        // syntax highlighting, and autocomplete.

        var _queryInput = document.getElementById('query-input');
        var _queryRunBtn = document.getElementById('query-run-btn');
        var _queryHelpBtn = document.getElementById('query-help-btn');
        var _queryHelp = document.getElementById('query-help');
        var _queryStatus = document.getElementById('query-status');
        var _queryResults = document.getElementById('query-results');
        var _queryHistoryEl = document.getElementById('query-history');
        var _queryHighlightCode = document.getElementById('query-highlight-code');
        var _queryHighlight = document.getElementById('query-highlight');
        var _queryAutocomplete = document.getElementById('query-autocomplete');
        var _queryHistory = [];
        var _acIndex = -1;
        var _acItems = [];
        var _acVisible = false;
        var _acBlurTimer = null;

        // ---- HeapQL schema ----
        var _hqlKeywords = ['SELECT','FROM','WHERE','ORDER','BY','ASC','DESC','LIMIT','AND','OR','LIKE','COUNT','SUM','AVG','MIN','MAX','GROUP','JOIN','INNER','LEFT','ON','AS','IN'];
        var _hqlTables = ['instances','class_histogram','dominator_tree','leak_suspects'];
        var _hqlTableColumns = {
            instances: ['object_id','node_type','class_name','shallow_size','retained_size'],
            class_histogram: ['class_name','instance_count','shallow_size','retained_size'],
            dominator_tree: ['object_id','node_type','class_name','shallow_size','retained_size'],
            leak_suspects: ['class_name','object_id','retained_size','retained_percentage','description']
        };
        var _hqlAllColumns = [];
        (function() {
            var seen = {};
            Object.keys(_hqlTableColumns).forEach(function(t) {
                _hqlTableColumns[t].forEach(function(c) {
                    if (!seen[c]) { seen[c] = true; _hqlAllColumns.push(c); }
                });
            });
        })();
        var _hqlSpecials = [':path',':refs',':children',':info'];
        var _hqlSizeSuffixes = /^(B|KB|MB|GB|TB|PB|EB)$/i;

        // ---- Tokenizer ----
        function tokenizeHeapQL(text) {
            var tokens = [];
            var i = 0;
            var len = text.length;
            while (i < len) {
                var ch = text[i];

                // Whitespace
                if (/\\s/.test(ch)) {
                    var start = i;
                    while (i < len && /\\s/.test(text[i])) i++;
                    tokens.push({ type: 'whitespace', text: text.slice(start, i) });
                    continue;
                }

                // Single-quoted string
                if (ch === "'") {
                    var start = i;
                    i++;
                    while (i < len && text[i] !== "'") i++;
                    if (i < len) i++; // closing quote
                    tokens.push({ type: 'string', text: text.slice(start, i) });
                    continue;
                }

                // Special command (:path, :refs, etc.)
                if (ch === ':') {
                    var start = i;
                    i++;
                    while (i < len && /[a-zA-Z]/.test(text[i])) i++;
                    var word = text.slice(start, i);
                    if (_hqlSpecials.indexOf(word.toLowerCase()) !== -1) {
                        tokens.push({ type: 'special', text: word });
                    } else {
                        tokens.push({ type: 'ident', text: word });
                    }
                    continue;
                }

                // Number (possibly with size suffix)
                if (/[0-9]/.test(ch)) {
                    var start = i;
                    while (i < len && /[0-9]/.test(text[i])) i++;
                    if (i < len && text[i] === '.') {
                        i++;
                        while (i < len && /[0-9]/.test(text[i])) i++;
                    }
                    // Optional size suffix
                    var suffStart = i;
                    while (i < len && /[a-zA-Z]/.test(text[i])) i++;
                    if (suffStart < i) {
                        var suf = text.slice(suffStart, i);
                        if (!_hqlSizeSuffixes.test(suf)) {
                            i = suffStart; // not a size suffix, rewind
                        }
                    }
                    tokens.push({ type: 'number', text: text.slice(start, i) });
                    continue;
                }

                // Two-char operators
                if (i + 1 < len) {
                    var two = text.slice(i, i + 2);
                    if (two === '!=' || two === '>=' || two === '<=') {
                        tokens.push({ type: 'operator', text: two });
                        i += 2;
                        continue;
                    }
                }

                // Single-char operators
                if (ch === '=' || ch === '>' || ch === '<') {
                    tokens.push({ type: 'operator', text: ch });
                    i++;
                    continue;
                }

                // Star
                if (ch === '*') {
                    tokens.push({ type: 'star', text: '*' });
                    i++;
                    continue;
                }

                // Comma
                if (ch === ',') {
                    tokens.push({ type: 'comma', text: ',' });
                    i++;
                    continue;
                }

                // Parentheses
                if (ch === '(' || ch === ')') {
                    tokens.push({ type: 'operator', text: ch });
                    i++;
                    continue;
                }

                // Identifier / keyword / table / column
                if (/[a-zA-Z_]/.test(ch)) {
                    var start = i;
                    while (i < len && /[a-zA-Z0-9_]/.test(text[i])) i++;
                    var word = text.slice(start, i);
                    var upper = word.toUpperCase();
                    if (_hqlKeywords.indexOf(upper) !== -1) {
                        tokens.push({ type: 'keyword', text: word });
                    } else if (_hqlTables.indexOf(word.toLowerCase()) !== -1) {
                        tokens.push({ type: 'table', text: word });
                    } else if (_hqlAllColumns.indexOf(word.toLowerCase()) !== -1) {
                        tokens.push({ type: 'column', text: word });
                    } else {
                        tokens.push({ type: 'ident', text: word });
                    }
                    continue;
                }

                // Anything else
                tokens.push({ type: 'ident', text: ch });
                i++;
            }
            return tokens;
        }

        function highlightHeapQL(text) {
            if (!text) return '';
            var tokens = tokenizeHeapQL(text);
            var html = '';
            tokens.forEach(function(tok) {
                var escaped = escapeHtml(tok.text);
                switch (tok.type) {
                    case 'keyword': html += '<span class="hql-keyword">' + escaped + '</span>'; break;
                    case 'table':   html += '<span class="hql-table">' + escaped + '</span>'; break;
                    case 'column':  html += '<span class="hql-column">' + escaped + '</span>'; break;
                    case 'string':  html += '<span class="hql-string">' + escaped + '</span>'; break;
                    case 'number':  html += '<span class="hql-number">' + escaped + '</span>'; break;
                    case 'operator':html += '<span class="hql-operator">' + escaped + '</span>'; break;
                    case 'special': html += '<span class="hql-special">' + escaped + '</span>'; break;
                    case 'star':    html += '<span class="hql-star">' + escaped + '</span>'; break;
                    default:        html += escaped; break;
                }
            });
            return html;
        }

        function syncHighlight() {
            var text = _queryInput.value;
            // Append a trailing newline so <pre> height matches when textarea ends with newline
            _queryHighlightCode.innerHTML = highlightHeapQL(text) + '\\n';
            _queryHighlight.scrollTop = _queryInput.scrollTop;
            _queryHighlight.scrollLeft = _queryInput.scrollLeft;
        }

        // Keep pre height synced to textarea (which can be resized)
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(function() {
                _queryHighlight.style.height = _queryInput.offsetHeight + 'px';
            }).observe(_queryInput);
        }

        _queryInput.addEventListener('scroll', function() {
            _queryHighlight.scrollTop = _queryInput.scrollTop;
            _queryHighlight.scrollLeft = _queryInput.scrollLeft;
        });

        // ---- Autocomplete ----
        function getFromTable(text) {
            // Find the table name after FROM in the query
            var m = text.match(/\\bFROM\\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
            return m ? m[1].toLowerCase() : null;
        }

        function getPartialWord(text, pos) {
            var before = text.slice(0, pos);
            var m = before.match(/[:a-zA-Z_][a-zA-Z0-9_]*$/);
            return m ? m[0] : '';
        }

        function getAutocompleteSuggestions(text, cursorPos) {
            var partial = getPartialWord(text, cursorPos).toLowerCase();
            var before = text.slice(0, cursorPos - partial.length).replace(/\\s+$/, '');
            var tokensBefore = tokenizeHeapQL(before);

            // Find last meaningful keyword
            var lastKw = '';
            for (var k = tokensBefore.length - 1; k >= 0; k--) {
                if (tokensBefore[k].type === 'keyword') {
                    lastKw = tokensBefore[k].text.toUpperCase();
                    break;
                }
            }

            var items = [];
            var fromTable = getFromTable(text);

            // Special command partial
            if (partial.charAt(0) === ':') {
                _hqlSpecials.forEach(function(s) {
                    if (s.indexOf(partial) === 0) {
                        items.push({ label: s, kind: 'command' });
                    }
                });
                return items;
            }

            if (lastKw === 'FROM') {
                _hqlTables.forEach(function(t) {
                    if (!partial || t.indexOf(partial) === 0) {
                        items.push({ label: t, kind: 'table' });
                    }
                });
            } else if (lastKw === 'SELECT' || lastKw === 'WHERE' || lastKw === 'BY') {
                var cols = fromTable && _hqlTableColumns[fromTable] ? _hqlTableColumns[fromTable] : _hqlAllColumns;
                cols.forEach(function(c) {
                    if (!partial || c.indexOf(partial) === 0) {
                        items.push({ label: c, kind: 'column' });
                    }
                });
                // Also suggest * after SELECT
                if (lastKw === 'SELECT' && (!partial || '*'.indexOf(partial) === 0)) {
                    items.unshift({ label: '*', kind: 'keyword' });
                }
                // Suggest aggregate functions after SELECT
                if (lastKw === 'SELECT') {
                    ['COUNT(','SUM(','AVG(','MIN(','MAX('].forEach(function(fn) {
                        if (!partial || fn.toLowerCase().indexOf(partial) === 0) {
                            items.push({ label: fn, kind: 'keyword' });
                        }
                    });
                }
            } else if (lastKw === 'GROUP') {
                if (!partial || 'by'.indexOf(partial) === 0) {
                    items.push({ label: 'BY', kind: 'keyword' });
                }
            } else if (lastKw === 'ORDER') {
                if (!partial || 'by'.indexOf(partial) === 0) {
                    items.push({ label: 'BY', kind: 'keyword' });
                }
            } else if (lastKw === 'AND' || lastKw === 'OR') {
                var cols = fromTable && _hqlTableColumns[fromTable] ? _hqlTableColumns[fromTable] : _hqlAllColumns;
                cols.forEach(function(c) {
                    if (!partial || c.indexOf(partial) === 0) {
                        items.push({ label: c, kind: 'column' });
                    }
                });
            } else {
                // Start of query or after a complete clause
                var kws = ['SELECT','FROM','WHERE','ORDER BY','GROUP BY','LIMIT','AND','OR'];
                kws.forEach(function(kw) {
                    if (!partial || kw.toLowerCase().indexOf(partial) === 0) {
                        items.push({ label: kw, kind: 'keyword' });
                    }
                });
                _hqlSpecials.forEach(function(s) {
                    if (!partial || s.indexOf(partial) === 0) {
                        items.push({ label: s, kind: 'command' });
                    }
                });
                // Also show tables
                _hqlTables.forEach(function(t) {
                    if (partial && t.indexOf(partial) === 0) {
                        items.push({ label: t, kind: 'table' });
                    }
                });
                // Also show columns if partial matches
                if (partial) {
                    var cols = fromTable && _hqlTableColumns[fromTable] ? _hqlTableColumns[fromTable] : _hqlAllColumns;
                    cols.forEach(function(c) {
                        if (c.indexOf(partial) === 0) {
                            items.push({ label: c, kind: 'column' });
                        }
                    });
                }
            }

            return items;
        }

        function showAutocomplete(items, partial) {
            _acItems = items;
            _acIndex = 0;
            _acVisible = true;
            var html = '';
            items.forEach(function(item, idx) {
                html += '<div class="query-ac-item' + (idx === 0 ? ' active' : '') + '" data-idx="' + idx + '" role="option"' + (idx === 0 ? ' aria-selected="true"' : ' aria-selected="false"') + '>'
                    + '<span class="query-ac-label">' + escapeHtml(item.label) + '</span>'
                    + '<span class="query-ac-kind">' + item.kind + '</span>'
                    + '</div>';
            });
            _queryAutocomplete.innerHTML = html;
            _queryAutocomplete.style.display = 'block';
            _queryInput.setAttribute('aria-expanded', 'true');

            // Position below the caret
            positionAutocomplete();

            // Mouse handlers
            var acItems = _queryAutocomplete.querySelectorAll('.query-ac-item');
            acItems.forEach(function(el) {
                el.addEventListener('mousedown', function(e) {
                    e.preventDefault();
                    var idx = parseInt(el.getAttribute('data-idx'), 10);
                    acceptSuggestion(idx);
                });
                el.addEventListener('mouseenter', function() {
                    var idx = parseInt(el.getAttribute('data-idx'), 10);
                    setActiveAcItem(idx);
                });
            });
        }

        function positionAutocomplete() {
            // Place dropdown at bottom-left of textarea
            _queryAutocomplete.style.top = _queryInput.offsetHeight + 'px';
            _queryAutocomplete.style.left = '0px';
        }

        function hideAutocomplete() {
            _acVisible = false;
            _acItems = [];
            _acIndex = -1;
            _queryAutocomplete.style.display = 'none';
            _queryAutocomplete.innerHTML = '';
            _queryInput.setAttribute('aria-expanded', 'false');
        }

        function setActiveAcItem(idx) {
            _acIndex = idx;
            var items = _queryAutocomplete.querySelectorAll('.query-ac-item');
            items.forEach(function(el, i) {
                el.classList.toggle('active', i === idx);
                el.setAttribute('aria-selected', i === idx ? 'true' : 'false');
            });
            // Scroll into view
            if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
        }

        function acceptSuggestion(idx) {
            if (idx < 0 || idx >= _acItems.length) return;
            var item = _acItems[idx];
            var text = _queryInput.value;
            var pos = _queryInput.selectionStart;
            var partial = getPartialWord(text, pos);
            var before = text.slice(0, pos - partial.length);
            var after = text.slice(pos);
            var insertion = item.label;
            // Add trailing space for keywords, tables, and commands
            if (item.kind === 'keyword' || item.kind === 'table' || item.kind === 'command') {
                insertion += ' ';
            }
            _queryInput.value = before + insertion + after;
            var newPos = before.length + insertion.length;
            _queryInput.setSelectionRange(newPos, newPos);
            _queryInput.focus();
            hideAutocomplete();
            syncHighlight();
        }

        function handleAutocomplete() {
            var text = _queryInput.value;
            var pos = _queryInput.selectionStart;
            var partial = getPartialWord(text, pos);

            // Don't show when cursor is not at a word boundary or query is empty
            if (!text.trim() && !partial) { hideAutocomplete(); return; }

            var suggestions = getAutocompleteSuggestions(text, pos);
            if (suggestions.length === 0) {
                hideAutocomplete();
                return;
            }

            showAutocomplete(suggestions, partial);
        }

        // ---- Event wiring ----
        function runQuery() {
            var q = _queryInput.value.trim();
            if (!q) return;
            hideAutocomplete();
            _queryStatus.className = 'query-status';
            _queryStatus.textContent = 'Running...';
            _queryResults.innerHTML = '';
            _queryRunBtn.disabled = true;
            vscode.postMessage({ command: 'executeQuery', query: q });
        }

        _queryRunBtn.addEventListener('click', runQuery);

        _queryInput.addEventListener('keydown', function(e) {
            // Ctrl/Cmd+Enter always runs query
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                runQuery();
                return;
            }

            if (_acVisible) {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActiveAcItem((_acIndex + 1) % _acItems.length);
                    return;
                }
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActiveAcItem((_acIndex - 1 + _acItems.length) % _acItems.length);
                    return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey)) {
                    e.preventDefault();
                    acceptSuggestion(_acIndex);
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    hideAutocomplete();
                    return;
                }
            }
        });

        _queryInput.addEventListener('input', function() {
            syncHighlight();
            handleAutocomplete();
        });

        _queryInput.addEventListener('blur', function() {
            _acBlurTimer = setTimeout(function() { hideAutocomplete(); }, 150);
        });

        _queryInput.addEventListener('focus', function() {
            if (_acBlurTimer) { clearTimeout(_acBlurTimer); _acBlurTimer = null; }
        });

        _queryHelpBtn.addEventListener('click', function() {
            _queryHelp.style.display = _queryHelp.style.display === 'none' ? 'block' : 'none';
        });

        // Initial highlight
        syncHighlight();

        function _addToHistory(q) {
            var idx = _queryHistory.indexOf(q);
            if (idx !== -1) _queryHistory.splice(idx, 1);
            _queryHistory.unshift(q);
            if (_queryHistory.length > 10) _queryHistory.pop();
            _renderQueryHistory();
        }

        function _renderQueryHistory() {
            _queryHistoryEl.innerHTML = '';
            _queryHistory.forEach(function(q) {
                var el = document.createElement('span');
                el.className = 'query-history-item';
                el.textContent = q;
                el.title = q;
                el.addEventListener('click', function() {
                    _queryInput.value = q;
                    _queryInput.focus();
                    syncHighlight();
                });
                _queryHistoryEl.appendChild(el);
            });
        }

        var QUERY_ROW_LIMIT = 500;

        var _lastPaginatedQuery = null;

        function renderQueryResult(result, query) {
            _queryRunBtn.disabled = false;
            _addToHistory(query);

            var cols = result.columns || [];
            var rows = result.rows || [];
            var scanned = result.total_scanned || 0;
            var matched = result.total_matched || 0;
            var timeMs = (result.execution_time_ms || 0).toFixed(1);
            var isPaginated = result.page != null;
            var totalRows = rows.length;
            var truncated = !isPaginated && totalRows > QUERY_ROW_LIMIT;
            var displayRows = truncated ? rows.slice(0, QUERY_ROW_LIMIT) : rows;

            if (isPaginated) {
                _lastPaginatedQuery = query;
                _queryStatus.className = 'query-status';
                _queryStatus.textContent = displayRows.length + ' row' + (displayRows.length !== 1 ? 's' : '') +
                    ' (page ' + result.page + '/' + result.total_pages + ', ' + result.total_rows + ' total, ' + timeMs + 'ms)';
            } else {
                _lastPaginatedQuery = null;
                _queryStatus.className = 'query-status';
                _queryStatus.textContent = displayRows.length + ' row' + (displayRows.length !== 1 ? 's' : '') +
                    ' returned (' + matched + ' matched, ' + scanned + ' scanned, ' + timeMs + 'ms)';
            }

            if (rows.length === 0 && !isPaginated) {
                _queryResults.innerHTML = '<div style="opacity:0.5; padding:12px;">No results</div>';
                return;
            }

            var html = '';
            if (truncated) {
                html += '<div class="query-limit-warning">Showing first ' + QUERY_ROW_LIMIT + ' of ' + totalRows + ' rows. Add LIMIT to your query.</div>';
            }

            var sizeCols = ['shallow_size', 'retained_size', 'wasted_bytes', 'total_bytes',
                'sum(shallow_size)', 'sum(retained_size)', 'avg(shallow_size)', 'avg(retained_size)',
                'min(shallow_size)', 'min(retained_size)', 'max(shallow_size)', 'max(retained_size)'];
            html += '<table><thead><tr>';
            cols.forEach(function(col) {
                var isSize = sizeCols.indexOf(col) !== -1;
                html += '<th' + (isSize ? ' class="right"' : '') + '>' + escapeHtml(col) + '</th>';
            });
            html += '</tr></thead><tbody>';

            displayRows.forEach(function(row) {
                html += '<tr>';
                row.forEach(function(val, i) {
                    var col = cols[i];
                    var isSize = sizeCols.indexOf(col) !== -1;
                    var display;
                    if (isSize && typeof val === 'number') display = fmt(val);
                    else if (typeof val === 'number' && col === 'retained_percentage') display = val.toFixed(1) + '%';
                    else if (typeof val === 'number') display = fmtNum(val);
                    else display = escapeHtml(String(val == null ? '' : val));
                    html += '<td' + (isSize ? ' class="right"' : '') + '>' + display + '</td>';
                });
                html += '</tr>';
            });
            html += '</tbody></table>';

            if (isPaginated) {
                html += '<div class="query-pagination" style="display:flex;align-items:center;gap:8px;padding:8px 0;">';
                var prevDisabled = result.page <= 1 ? ' disabled' : '';
                var nextDisabled = result.page >= result.total_pages ? ' disabled' : '';
                html += '<button class="query-page-btn" data-page="' + (result.page - 1) + '"' + prevDisabled + '>Prev</button>';
                html += '<span>Page ' + result.page + ' of ' + result.total_pages + '</span>';
                html += '<button class="query-page-btn" data-page="' + (result.page + 1) + '"' + nextDisabled + '>Next</button>';
                html += '</div>';
            }

            _queryResults.innerHTML = html;

            if (isPaginated) {
                var pageBtns = _queryResults.querySelectorAll('.query-page-btn');
                pageBtns.forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        if (btn.disabled) return;
                        var page = parseInt(btn.getAttribute('data-page'), 10);
                        if (_lastPaginatedQuery && page >= 1) {
                            vscode.postMessage({ command: 'executeQuery', query: _lastPaginatedQuery, page: page, pageSize: 500 });
                        }
                    });
                });
            }
        }

        function renderQueryError(error, query) {
            _queryRunBtn.disabled = false;
            if (query) _addToHistory(query);
            _queryStatus.className = 'query-status error';
            _queryStatus.textContent = 'Error: ' + error;
            _queryResults.innerHTML = '';
        }

        // ---- Self-register ----
        onMessage('queryResult', function(msg) {
            // Update input box if the query came from elsewhere (e.g. Chat tab)
            if (msg.query && _queryInput.value.trim() !== msg.query.trim()) {
                _queryInput.value = msg.query;
                syncHighlight();
            }
            renderQueryResult(msg.result, msg.query);
        });

        onMessage('queryError', function(msg) {
            renderQueryError(msg.error, msg.query);
        });
    `;
}
