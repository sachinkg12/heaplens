export function getInspectorJs(): string {
    return `
        // ---- Object Inspector ----
        // Self-contained: owns explain-object streaming buffer.

        var _explainObjectBuffer = '';

        function openInspector(objectId, className, shallowSize, retainedSize) {
            var panel = document.getElementById('inspector-panel');
            panel.dataset.objectId = objectId;
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
            var panel = document.getElementById('inspector-panel');
            panel.classList.remove('visible');
            panel.innerHTML = '';
        }

        function renderInspectorFields(objectId, fields) {
            var panel = document.getElementById('inspector-panel');
            if (!panel.classList.contains('visible')) return;

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
                    vscode.postMessage({
                        command: 'explainObject',
                        objectId: parseInt(panel.dataset.objectId),
                        className: panel.dataset.className,
                        shallowSize: parseInt(panel.dataset.shallowSize),
                        retainedSize: parseInt(panel.dataset.retainedSize),
                        fields: fields
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
            _explainObjectBuffer += msg.text;
            var area = document.getElementById('inspector-explain-area');
            if (area) {
                area.textContent = _explainObjectBuffer;
                area.scrollTop = area.scrollHeight;
            }
        });

        onMessage('explainDone', function() {
            var area = document.getElementById('inspector-explain-area');
            if (area) {
                area.classList.remove('streaming');
                area.classList.add('rendered');
                area.innerHTML = renderMarkdown(_explainObjectBuffer);
                area.scrollTop = 0;
            }
            _explainObjectBuffer = '';
            var btn = document.getElementById('inspector-explain-btn');
            if (btn) { btn.textContent = 'Explain this object'; btn.disabled = false; }
        });

        onMessage('explainError', function(msg) {
            _explainObjectBuffer = '';
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
