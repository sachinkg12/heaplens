export function getLeakSuspectsJs(): string {
    return `
        // ---- Tab 4: Leak Suspects (Dual-View: By Object + By Class) ----
        // Self-contained: owns explain-leak streaming buffers, rendering, pagination, threshold filtering.

        var _explainLeakBuffers = {};
        var _leakPage = 0;
        var LEAK_PAGE_SIZE = 10;
        var _leakSuspectsData = [];
        var _allLeakSuspects = [];
        var _leakThreshold = 10;

        // Object-level suspects state
        var _objLeakPage = 0;
        var _objLeakSuspectsData = [];
        var _allObjLeakSuspects = [];
        var _currentLeakView = 'object'; // 'object' or 'class'

        // ---- Toggle logic ----
        document.querySelectorAll('.leak-toggle-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.leak-toggle-btn').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                _currentLeakView = btn.dataset.view;
                var objContainer = document.getElementById('object-suspects');
                var classContainer = document.getElementById('leak-suspects');
                var thresholdRow = document.getElementById('leak-threshold-row');
                if (_currentLeakView === 'object') {
                    objContainer.style.display = 'block';
                    classContainer.style.display = 'none';
                    if (thresholdRow) thresholdRow.style.display = _allObjLeakSuspects.length > 0 ? 'flex' : 'none';
                } else {
                    objContainer.style.display = 'none';
                    classContainer.style.display = 'block';
                    if (thresholdRow) thresholdRow.style.display = _allLeakSuspects.length > 0 ? 'flex' : 'none';
                }
            });
        });

        // ---- Object-level suspect rendering ----
        function renderObjectLeakSuspects(suspects) {
            _allObjLeakSuspects = suspects || [];
            _objLeakPage = 0;
            applyObjLeakThreshold();
        }

        function applyObjLeakThreshold() {
            _objLeakSuspectsData = _allObjLeakSuspects.filter(function(s) {
                return s.retained_percentage >= _leakThreshold;
            });
            _objLeakPage = 0;

            // Show/hide threshold row (only when object view is active)
            if (_currentLeakView === 'object') {
                var thresholdRow = document.getElementById('leak-threshold-row');
                if (thresholdRow) {
                    thresholdRow.style.display = _allObjLeakSuspects.length > 0 ? 'flex' : 'none';
                }
            }

            renderObjLeakPage();
        }

        function renderObjLeakPage() {
            var container = document.getElementById('object-suspects');
            var suspects = _objLeakSuspectsData;

            if (_allObjLeakSuspects.length === 0) {
                container.innerHTML = '<div class="loading">No individual object leak suspects detected (no single object retains >10% of heap)</div>';
                return;
            }

            if (suspects.length === 0) {
                container.innerHTML = '<div class="loading">No suspects at current threshold (' + _leakThreshold + '%). Lower the minimum retained % to see more.</div>';
                return;
            }

            var totalPages = Math.ceil(suspects.length / LEAK_PAGE_SIZE);
            var start = _objLeakPage * LEAK_PAGE_SIZE;
            var pageSuspects = suspects.slice(start, start + LEAK_PAGE_SIZE);

            var html = pageSuspects.map(function(s) {
                var severity = s.retained_percentage > 30 ? 'high' : 'medium';
                var objIdHex = s.object_id ? '0x' + s.object_id.toString(16) : '';
                var sourceLink = isResolvableClass(s.class_name)
                    ? ' | <a class="go-to-source-link" data-class="' + escapeHtml(s.class_name) + '">View Source</a>'
                    : '';
                var gcPathLink = s.object_id
                    ? ' <button class="why-alive-btn gc-path-link" data-object-id="' + s.object_id + '">Why alive?</button>'
                    : '';
                var inspectLink = s.object_id
                    ? ' <button class="why-alive-btn inspect-obj-link" data-object-id="' + s.object_id + '">Inspect</button>'
                    : '';
                var sanitizedId = (s.class_name + '_' + s.object_id).replace(/[^a-zA-Z0-9]/g, '_');
                var explainLink = ' | <a class="suspect-explain-link" data-class="' + escapeHtml(s.class_name) +
                    '" data-object-id="' + (s.object_id || '') +
                    '" data-retained="' + s.retained_size +
                    '" data-pct="' + s.retained_percentage +
                    '" data-desc="' + escapeHtml(s.description) +
                    '" data-target="explain-obj-' + sanitizedId + '">Explain</a>';
                return '<div class="suspect-card ' + severity + '" data-class="' + escapeHtml(s.class_name) + '">' +
                    '<div class="suspect-header">' +
                    '<span class="suspect-badge ' + severity + '">' + (severity === 'high' ? 'HIGH' : 'MEDIUM') + '</span>' +
                    '<span class="suspect-class">' + escapeHtml(s.class_name) + '</span>' +
                    (objIdHex ? '<span class="suspect-obj-id">@ ' + objIdHex + '</span>' : '') +
                    '</div>' +
                    '<div class="suspect-desc">' + escapeHtml(s.description) + '</div>' +
                    '<div style="margin-top:8px;opacity:0.6;font-size:12px;">Retained: ' + fmt(s.retained_size) +
                    ' (' + s.retained_percentage.toFixed(1) + '% of heap)' +
                    sourceLink + gcPathLink + inspectLink + explainLink + '</div>' +
                    '<div class="suspect-explain-area" id="explain-obj-' + sanitizedId + '"></div>' +
                    '</div>';
            }).join('');

            // Pagination controls
            if (totalPages > 1) {
                html += '<div class="leak-pagination">';
                html += '<button class="btn leak-prev-btn obj-prev-btn"' + (_objLeakPage === 0 ? ' disabled' : '') + '>Prev</button>';
                html += '<span class="leak-page-info">Page ' + (_objLeakPage + 1) + ' of ' + totalPages + '</span>';
                html += '<button class="btn leak-next-btn obj-next-btn"' + (_objLeakPage >= totalPages - 1 ? ' disabled' : '') + '>Next</button>';
                html += '</div>';
            }

            container.innerHTML = html;

            // Wire up pagination
            var prevBtn = container.querySelector('.obj-prev-btn');
            var nextBtn = container.querySelector('.obj-next-btn');
            if (prevBtn) prevBtn.addEventListener('click', function() { if (_objLeakPage > 0) { _objLeakPage--; renderObjLeakPage(); } });
            if (nextBtn) nextBtn.addEventListener('click', function() { var tp = Math.ceil(_objLeakSuspectsData.length / LEAK_PAGE_SIZE); if (_objLeakPage < tp - 1) { _objLeakPage++; renderObjLeakPage(); } });

            wireUpSuspectLinks(container);
        }

        // ---- Class-level suspect rendering (existing logic) ----
        function renderLeakSuspects(suspects) {
            _allLeakSuspects = suspects || [];
            _leakPage = 0;
            applyLeakThreshold();
        }

        function applyLeakThreshold() {
            _leakSuspectsData = _allLeakSuspects.filter(function(s) {
                return s.retained_percentage >= _leakThreshold;
            });
            _leakPage = 0;

            // Show/hide threshold row (only when class view is active)
            if (_currentLeakView === 'class') {
                var thresholdRow = document.getElementById('leak-threshold-row');
                if (thresholdRow) {
                    thresholdRow.style.display = _allLeakSuspects.length > 0 ? 'flex' : 'none';
                }
            }

            renderLeakPage();
        }

        function renderLeakPage() {
            var container = document.getElementById('leak-suspects');
            var suspects = _leakSuspectsData;

            if (_allLeakSuspects.length === 0) {
                container.innerHTML = '<div class="loading">No leak suspects detected (no single object or class retains >10% of heap)</div>';
                return;
            }

            if (suspects.length === 0) {
                container.innerHTML = '<div class="loading">No suspects at current threshold (' + _leakThreshold + '%). Lower the minimum retained % to see more.</div>';
                return;
            }

            var totalPages = Math.ceil(suspects.length / LEAK_PAGE_SIZE);
            var start = _leakPage * LEAK_PAGE_SIZE;
            var pageSuspects = suspects.slice(start, start + LEAK_PAGE_SIZE);

            var html = pageSuspects.map(function(s) {
                var severity = s.retained_percentage > 30 ? 'high' : 'medium';
                var sourceLink = isResolvableClass(s.class_name)
                    ? ' | <a class="go-to-source-link" data-class="' + escapeHtml(s.class_name) + '">View Source</a>'
                    : '';
                var fixLink = isResolvableClass(s.class_name)
                    ? ' | <a class="fix-with-ai-link" data-class="' + escapeHtml(s.class_name) +
                      '" data-retained="' + s.retained_size +
                      '" data-pct="' + s.retained_percentage +
                      '" data-desc="' + escapeHtml(s.description) + '">Fix with AI</a>'
                    : '';
                var gcPathLink = s.object_id
                    ? ' <button class="why-alive-btn gc-path-link" data-object-id="' + s.object_id + '">Why alive?</button>'
                    : '';
                var cachedDep = depInfoCache[s.class_name];
                var depBadge = cachedDep ? makeBadgeHtml(cachedDep.tier, cachedDep.dependency) : '';
                var sanitizedId = s.class_name.replace(/[^a-zA-Z0-9]/g, '_');
                var explainLink = ' | <a class="suspect-explain-link" data-class="' + escapeHtml(s.class_name) +
                    '" data-retained="' + s.retained_size +
                    '" data-pct="' + s.retained_percentage +
                    '" data-desc="' + escapeHtml(s.description) +
                    '" data-target="explain-' + sanitizedId + '">Explain</a>';
                return '<div class="suspect-card ' + severity + '" data-class="' + escapeHtml(s.class_name) + '">' +
                    '<div class="suspect-header">' +
                    '<span class="suspect-class">' + escapeHtml(s.class_name) + '</span>' +
                    '<span class="suspect-badge ' + severity + '">' + s.retained_percentage.toFixed(1) + '%</span>' +
                    '</div>' +
                    '<div class="suspect-desc">' + escapeHtml(s.description) + '</div>' +
                    '<div style="margin-top:8px;opacity:0.6;font-size:12px;">Retained: ' + fmt(s.retained_size) +
                    (s.object_id ? ' | Object ID: ' + s.object_id : '') +
                    sourceLink + gcPathLink + explainLink + fixLink + depBadge + '</div>' +
                    '<div class="suspect-explain-area" id="explain-' + sanitizedId + '"></div>' +
                    '</div>';
            }).join('');

            // Pagination controls
            if (totalPages > 1) {
                html += '<div class="leak-pagination">';
                html += '<button class="btn leak-prev-btn class-prev-btn"' + (_leakPage === 0 ? ' disabled' : '') + '>Prev</button>';
                html += '<span class="leak-page-info">Page ' + (_leakPage + 1) + ' of ' + totalPages + '</span>';
                html += '<button class="btn leak-next-btn class-next-btn"' + (_leakPage >= totalPages - 1 ? ' disabled' : '') + '>Next</button>';
                html += '</div>';
            }

            container.innerHTML = html;

            // Wire up pagination
            var prevBtn = container.querySelector('.class-prev-btn');
            var nextBtn = container.querySelector('.class-next-btn');
            if (prevBtn) prevBtn.addEventListener('click', function() { if (_leakPage > 0) { _leakPage--; renderLeakPage(); } });
            if (nextBtn) nextBtn.addEventListener('click', function() { var tp = Math.ceil(_leakSuspectsData.length / LEAK_PAGE_SIZE); if (_leakPage < tp - 1) { _leakPage++; renderLeakPage(); } });

            wireUpSuspectLinks(container);
        }

        // ---- Shared link wiring for both views ----
        function wireUpSuspectLinks(container) {
            container.querySelectorAll('.go-to-source-link').forEach(function(link) {
                link.addEventListener('click', function(e) {
                    e.preventDefault();
                    vscode.postMessage({ command: 'goToSource', className: link.dataset.class });
                });
            });

            container.querySelectorAll('.gc-path-link').forEach(function(link) {
                link.addEventListener('click', function(e) {
                    e.preventDefault();
                    var objectId = parseInt(link.dataset.objectId, 10);
                    if (objectId) vscode.postMessage({ command: 'gcRootPath', objectId: objectId });
                });
            });

            container.querySelectorAll('.inspect-obj-link').forEach(function(link) {
                link.addEventListener('click', function(e) {
                    e.preventDefault();
                    var objectId = parseInt(link.dataset.objectId, 10);
                    if (objectId) vscode.postMessage({ command: 'inspectObject', objectId: objectId });
                });
            });

            container.querySelectorAll('.suspect-explain-link').forEach(function(link) {
                link.addEventListener('click', function(e) {
                    e.preventDefault();
                    var targetId = link.dataset.target;
                    var area = document.getElementById(targetId);
                    if (!area) return;
                    link.textContent = 'Analyzing...';
                    area.classList.add('visible', 'streaming');
                    area.classList.remove('error');
                    area.textContent = '';
                    var msgPayload = {
                        command: 'explainLeakSuspect',
                        className: link.dataset.class,
                        retainedSize: parseFloat(link.dataset.retained),
                        retainedPercentage: parseFloat(link.dataset.pct),
                        description: link.dataset.desc
                    };
                    if (link.dataset.objectId) {
                        msgPayload.objectId = parseInt(link.dataset.objectId, 10);
                    }
                    vscode.postMessage(msgPayload);
                });
            });

            container.querySelectorAll('.fix-with-ai-link').forEach(function(link) {
                link.addEventListener('click', function(e) {
                    e.preventDefault();
                    if (link.classList.contains('disabled') || link.classList.contains('fixed')) return;
                    vscode.postMessage({
                        command: 'fixWithAi',
                        className: link.dataset.class,
                        retainedSize: parseFloat(link.dataset.retained),
                        retainedPercentage: parseFloat(link.dataset.pct),
                        description: link.dataset.desc
                    });
                });
            });
        }

        // Threshold slider — applies to whichever view is active
        var _leakSlider = document.getElementById('leak-threshold-slider');
        var _leakThresholdValue = document.getElementById('leak-threshold-value');
        if (_leakSlider) {
            _leakSlider.addEventListener('input', function() {
                _leakThreshold = parseInt(_leakSlider.value, 10);
                if (_leakThresholdValue) _leakThresholdValue.textContent = _leakThreshold + '%';
                applyLeakThreshold();
                applyObjLeakThreshold();
            });
        }

        // ---- Self-register ----
        onTabMessage('leaks', 'analysisComplete', function(msg) {
            renderLeakSuspects(msg.leakSuspects || []);
            renderObjectLeakSuspects(msg.objectLeakSuspects || []);
        });

        onMessage('explainLeakChunk', function(msg) {
            var classSanitized = msg.className.replace(/[^a-zA-Z0-9]/g, '_');
            // For object-level suspects, the explain area ID includes the objectId
            var objSanitized = msg.objectId ? (msg.className + '_' + msg.objectId).replace(/[^a-zA-Z0-9]/g, '_') : classSanitized;
            var bufferKey = msg.objectId ? objSanitized : classSanitized;
            if (!_explainLeakBuffers[bufferKey]) _explainLeakBuffers[bufferKey] = '';
            _explainLeakBuffers[bufferKey] += msg.text;
            // Try object-view first when objectId is present, then class-view
            var area = msg.objectId
                ? (document.getElementById('explain-obj-' + objSanitized) || document.getElementById('explain-' + classSanitized))
                : (document.getElementById('explain-' + classSanitized) || document.getElementById('explain-obj-' + objSanitized));
            if (area) {
                area.textContent = _explainLeakBuffers[bufferKey];
                area.scrollTop = area.scrollHeight;
            }
        });

        onMessage('explainLeakDone', function(msg) {
            var classSanitized = msg.className.replace(/[^a-zA-Z0-9]/g, '_');
            var objSanitized = msg.objectId ? (msg.className + '_' + msg.objectId).replace(/[^a-zA-Z0-9]/g, '_') : classSanitized;
            var bufferKey = msg.objectId ? objSanitized : classSanitized;
            // Try class-view explain area
            var classArea = document.getElementById('explain-' + classSanitized);
            if (classArea) {
                classArea.classList.remove('streaming');
                classArea.classList.add('rendered');
                classArea.innerHTML = renderMarkdown(_explainLeakBuffers[bufferKey] || '');
                classArea.scrollTop = 0;
            }
            // Try object-view explain area
            var objArea = document.getElementById('explain-obj-' + objSanitized);
            if (objArea) {
                objArea.classList.remove('streaming');
                objArea.classList.add('rendered');
                objArea.innerHTML = renderMarkdown(_explainLeakBuffers[bufferKey] || '');
                objArea.scrollTop = 0;
            }
            delete _explainLeakBuffers[bufferKey];
            document.querySelectorAll('.suspect-explain-link[data-class="' + msg.className + '"]').forEach(function(link) {
                link.textContent = 'Explain';
            });
        });

        onMessage('explainLeakError', function(msg) {
            var classSanitized = msg.className.replace(/[^a-zA-Z0-9]/g, '_');
            var objSanitized = msg.objectId ? (msg.className + '_' + msg.objectId).replace(/[^a-zA-Z0-9]/g, '_') : classSanitized;
            var bufferKey = msg.objectId ? objSanitized : classSanitized;
            delete _explainLeakBuffers[bufferKey];
            // Try class-view explain area
            var classArea = document.getElementById('explain-' + classSanitized);
            if (classArea) {
                classArea.classList.remove('streaming');
                classArea.classList.add('error', 'visible');
                classArea.textContent = msg.message || 'An error occurred';
            }
            // Try object-view explain area
            var objArea = document.getElementById('explain-obj-' + objSanitized);
            if (objArea) {
                objArea.classList.remove('streaming');
                objArea.classList.add('error', 'visible');
                objArea.textContent = msg.message || 'An error occurred';
            }
            document.querySelectorAll('.suspect-explain-link[data-class="' + msg.className + '"]').forEach(function(link) {
                link.textContent = 'Explain';
            });
        });
    `;
}
