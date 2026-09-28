export function getProgressJs(): string {
    return `
        // ---- Progress Bar + File Metadata + Cancel/Crash Recovery ----
        // Self-contained: shows multi-phase progress, file metadata,
        // cancel button, and crash/cancel recovery UI.

        var _progressPhaseLabels = {
            loading: 'Loading file',
            graph_building: 'Building graph',
            graph_built: 'Graph built',
            dominators: 'Computing dominators'
        };
        var _progressActive = false;

        function renderProgressBar(stage, phase, totalPhases) {
            var bar = document.getElementById('progress-bar');
            if (!bar) return;
            _progressActive = true;
            var html = '<div class="progress-steps">';
            for (var i = 1; i <= totalPhases; i++) {
                var cls = 'progress-step';
                if (i < phase) cls += ' done';
                else if (i === phase) cls += ' active';
                html += '<div class="' + cls + '">';
                html += '<span class="progress-dot"></span>';
                if (i === phase) {
                    var label = _progressPhaseLabels[stage] || ('Phase ' + i);
                    html += '<span class="progress-label">' + escapeHtml(label) + '...</span>';
                }
                html += '</div>';
                if (i < totalPhases) html += '<span class="progress-connector' + (i < phase ? ' done' : '') + '"></span>';
            }
            html += '<button class="btn progress-cancel-btn" id="progress-cancel-btn" style="margin-left:16px;font-size:11px;padding:4px 10px;">Cancel</button>';
            html += '</div>';
            bar.innerHTML = html;
            bar.style.display = 'block';

            document.getElementById('progress-cancel-btn').addEventListener('click', function() {
                vscode.postMessage({ command: 'cancelAnalysis' });
            });
        }

        function renderFileMetadata(meta) {
            var el = document.getElementById('file-metadata');
            if (!el || !meta) return;
            var parts = [];
            if (meta.file_size) parts.push('File size: ' + fmt(meta.file_size));
            if (parts.length > 0) {
                el.innerHTML = parts.map(function(p) { return '<span class="file-meta-item">' + p + '</span>'; }).join('');
                el.style.display = 'flex';
            }
        }

        function renderHprofVersion(summary) {
            var el = document.getElementById('file-metadata');
            if (!el || !summary || !summary.hprof_version) return;
            var isAndroid = summary.hprof_version.indexOf('1.0.3') !== -1;
            if (isAndroid) {
                var badge = document.createElement('span');
                badge.className = 'file-meta-item android-badge';
                badge.textContent = 'Android';
                el.appendChild(badge);
                el.style.display = 'flex';
            }
        }

        function showProgressMessage(html) {
            var bar = document.getElementById('progress-bar');
            if (!bar) return;
            bar.innerHTML = '<div class="progress-message">' + html + '</div>';
            bar.style.display = 'block';
        }

        onMessage('analysisProgress', function(msg) {
            if (msg.stage === 'cancelled') {
                _progressActive = false;
                showProgressMessage(
                    '<span style="opacity:0.7;">Analysis cancelled.</span> ' +
                    '<button class="btn" id="progress-retry-btn" style="font-size:11px;padding:4px 10px;">Retry</button>'
                );
                var retryBtn = document.getElementById('progress-retry-btn');
                if (retryBtn) retryBtn.addEventListener('click', function() { vscode.postMessage({ command: 'retryAnalysis' }); });
                return;
            }
            if (msg.phase && msg.totalPhases) {
                renderProgressBar(msg.stage, msg.phase, msg.totalPhases);
            }
            if (msg.fileMetadata) {
                renderFileMetadata(msg.fileMetadata);
            }
            if (msg.summary) {
                renderHprofVersion(msg.summary);
            }
        });

        onMessage('analysisCancelled', function() {
            _progressActive = false;
            showProgressMessage(
                '<span style="opacity:0.7;">Analysis cancelled.</span> ' +
                '<button class="btn" id="progress-retry-btn" style="font-size:11px;padding:4px 10px;">Retry</button>'
            );
            var retryBtn = document.getElementById('progress-retry-btn');
            if (retryBtn) retryBtn.addEventListener('click', function() { vscode.postMessage({ command: 'retryAnalysis' }); });
        });

        onMessage('serverCrashed', function() {
            _progressActive = false;
            showProgressMessage(
                '<span style="color:var(--vscode-editorError-foreground);">Analysis server crashed.</span> ' +
                '<button class="btn" id="progress-retry-btn" style="font-size:11px;padding:4px 10px;">Retry</button>'
            );
            var retryBtn = document.getElementById('progress-retry-btn');
            if (retryBtn) retryBtn.addEventListener('click', function() { vscode.postMessage({ command: 'retryAnalysis' }); });
        });

        onMessage('analysisRetrying', function() {
            showProgressMessage('<span style="opacity:0.7;">Retrying analysis...</span>');
        });

        onMessage('analysisFailed', function(msg) {
            _progressActive = false;
            showProgressMessage(
                '<span style="color:var(--vscode-editorError-foreground);">' + escapeHtml(msg.message || 'Analysis failed.') + '</span> ' +
                '<button class="btn" id="progress-retry-btn" style="font-size:11px;padding:4px 10px;">Retry</button>'
            );
            var retryBtn = document.getElementById('progress-retry-btn');
            if (retryBtn) retryBtn.addEventListener('click', function() { vscode.postMessage({ command: 'retryAnalysis' }); });
        });

        onMessage('analysisComplete', function() {
            _progressActive = false;
            var bar = document.getElementById('progress-bar');
            if (bar) bar.style.display = 'none';
        });
    `;
}
