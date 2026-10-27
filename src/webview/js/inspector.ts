export function getInspectorJs(): string {
    return `
        // ---- Object Inspector ----
        // Self-contained: owns explain-object streaming buffer.

        var _explainObjectBuffer = '';
        var _explainObjectSelection = null;

        function openInspector(objectId, className, shallowSize, retainedSize) {
            if (_explainObjectSelection !== null) vscode.postMessage({command:'stopAi'});
            _explainObjectSelection = null; _explainObjectBuffer = '';
            var panel = document.getElementById('inspector-panel');
            panel.dataset.objectId = objectId;
            panel.dataset.exactObjectId = (typeof objectId === 'string' && /^[1-9][0-9]{0,19}$/.test(objectId) || typeof objectId === 'number' && Number.isSafeInteger(objectId) && objectId > 0) ? String(objectId) : '';
            panel.dataset.className = className;
            panel.dataset.shallowSize = shallowSize;
            panel.dataset.retainedSize = retainedSize;
            panel.innerHTML = '<div class="inspector-header"><h3>' + escapeHtml(className) + '</h3><button class="inspector-close">&times;</button></div>' +
                '<div style="padding:8px 16px;font-size:11px;opacity:0.6;">Shallow: ' + fmt(shallowSize) + ' | Retained: ' + fmt(retainedSize) + '</div>' +
                '<div class="inspector-loading">Loading fields...</div>';
            panel.classList.add('visible');
            panel.querySelector('.inspector-close').addEventListener('click', closeInspector);
            vscode.postMessage({ command: 'inspectObject', objectId: objectId });
        }

        function closeInspector() {
            if (_explainObjectSelection !== null) vscode.postMessage({command:'stopAi'});
            _explainObjectSelection = null; _explainObjectBuffer = '';
            var panel = document.getElementById('inspector-panel');
            panel.classList.remove('visible');
            panel.innerHTML = '';
        }

        function renderInspectorFields(objectId, fields) {
            var panel = document.getElementById('inspector-panel');
            if (!panel.classList.contains('visible')) return;
            if (String(objectId) !== panel.dataset.objectId) return;

            var body = panel.querySelector('.inspector-loading');
            if (!body) return;

            if (!fields || fields.length === 0) {
                body.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.5;">No fields found</div>';
                body.className = 'inspector-body';
                return;
            }

            var html = '';
            fields.forEach(function(f) {
                var valueHtml = '';
                if (f.primitive_value !== undefined && f.primitive_value !== null) {
                    valueHtml = '<span class="inspector-field-value">' + escapeHtml(String(f.primitive_value)) + '</span>';
                } else if (f.ref_object_id) {
                    var refLabel = f.ref_summary ? f.ref_summary.class_name : '0x' + f.ref_object_id.toString(16);
                    valueHtml = '<span class="inspector-field-value"><span class="inspector-ref-link" data-ref-id="' + f.ref_object_id + '" data-ref-class="' + escapeHtml(refLabel) + '">' + escapeHtml(refLabel) + '</span></span>';
                    if (f.ref_summary) {
                        valueHtml += '<span class="inspector-sizes">' + fmt(f.ref_summary.retained_size) + '</span>';
                    }
                } else {
                    valueHtml = '<span class="inspector-field-value" style="opacity:0.4">\\u2014</span>';
                }
                html += '<div class="inspector-field">' +
                    '<span class="inspector-field-name">' + escapeHtml(f.name) + '</span>' +
                    '<span class="inspector-field-type">' + escapeHtml(f.field_type) + '</span>' +
                    valueHtml +
                    '</div>';
            });

            html += '<button class="inspector-explain-btn" id="inspector-explain-btn">Explain this object</button>';
            html += '<div id="inspector-explain-area" class="inspector-explain-area"></div>';

            body.className = 'inspector-body';
            body.innerHTML = html;

            body.querySelectorAll('.inspector-ref-link').forEach(function(link) {
                link.addEventListener('click', function() {
                    var refId = parseInt(link.dataset.refId);
                    var refClass = link.dataset.refClass || '';
                    if (refId > 0) openInspector(refId, refClass, 0, 0);
                });
            });

            var explainBtn = document.getElementById('inspector-explain-btn');
            var explainArea = document.getElementById('inspector-explain-area');
            if (explainBtn && explainArea) {
                explainBtn.addEventListener('click', function() {
                    explainBtn.disabled = true;
                    explainBtn.textContent = 'Analyzing...';
                    _explainObjectBuffer = '';
                    explainArea.classList.add('visible', 'streaming');
                    explainArea.classList.remove('error', 'rendered');
                    explainArea.textContent = '';

                    var panel = document.getElementById('inspector-panel');
                    if (!panel.dataset.exactObjectId) { explainArea.textContent = 'Object identity is not exact. This object cannot be sent to AI.'; explainBtn.disabled = false; return; }
                    _explainObjectSelection = panel.dataset.exactObjectId;
                    vscode.postMessage({
                        command: 'explainObject',
                        objectId: panel.dataset.exactObjectId,
                        className: panel.dataset.className
                    });
                });
            }
        }

        // ---- Self-register ----
        onMessage('inspectObjectLoading', function(msg) {
            var panel = document.getElementById('inspector-panel');
            if (!panel || !panel.classList.contains('visible')) return;
            var body = panel.querySelector('.inspector-loading, .inspector-body');
            if (body) {
                body.className = 'inspector-loading';
                body.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:20px;"><span class="spinner"></span> Loading fields\u2026 This may take a moment for large heap dumps.</div>';
            }
        });

        onMessage('inspectObjectResponse', function(msg) {
            renderInspectorFields(msg.objectId, msg.fields);
        });

        onMessage('explainChunk', function(msg) {
            var panel = document.getElementById('inspector-panel');
            if (!_explainObjectSelection || String(msg.objectId) !== _explainObjectSelection || panel.dataset.objectId !== _explainObjectSelection) return;
            _explainObjectBuffer += msg.text;
            var area = document.getElementById('inspector-explain-area');
            if (area) {
                area.textContent = _explainObjectBuffer;
                area.scrollTop = area.scrollHeight;
            }
        });

        onMessage('explainDone', function(msg) {
            var panel = document.getElementById('inspector-panel');
            if (!_explainObjectSelection || String(msg.objectId) !== _explainObjectSelection || panel.dataset.objectId !== _explainObjectSelection) return;
            var area = document.getElementById('inspector-explain-area');
            if (area) {
                area.classList.remove('streaming');
                area.classList.add('rendered');
                if (msg.safeEvidenceAnswer) {
                    area.innerHTML = renderMarkdown(_explainObjectBuffer); // Escapes HTML; never executes model output.
                    attachInvestigationEvidence(area, msg.evidence);
                } else { area.innerHTML = renderMarkdown(_explainObjectBuffer); }
                area.scrollTop = 0;
            }
            _explainObjectBuffer = '';
            _explainObjectSelection = null;
            var btn = document.getElementById('inspector-explain-btn');
            if (btn) { btn.textContent = 'Explain this object'; btn.disabled = false; }
        });

        onMessage('explainError', function(msg) {
            var panel = document.getElementById('inspector-panel');
            if (!_explainObjectSelection || String(msg.objectId) !== _explainObjectSelection || panel.dataset.objectId !== _explainObjectSelection) return;
            _explainObjectBuffer = '';
            _explainObjectSelection = null;
            var area = document.getElementById('inspector-explain-area');
            if (area) {
                area.classList.remove('streaming');
                area.classList.add('error', 'visible');
                area.textContent = msg.message || 'An error occurred';
            }
            var btn = document.getElementById('inspector-explain-btn');
            if (btn) { btn.textContent = 'Explain this object'; btn.disabled = false; }
        });
    `;
}
