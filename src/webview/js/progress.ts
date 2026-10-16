export function getProgressJs(): string {
    return `
        // ---- Progress Bar + File Metadata + Cancel/Crash Recovery ----
        // Self-contained: shows multi-phase progress, file metadata,
        // cancel button, and crash/cancel recovery UI.

        var _progressPhaseLabels = {
            starting: 'Starting analysis',
            quick_scan: 'Scanning shallow allocations',
            loading: 'Loading file',
            graph_building: 'Building graph',
            graph_built: 'Graph built',
            sizing: 'Reading heap records',
            catalog_building: 'Building object catalogs',
            shallow_ready: 'Overview and shallow histogram ready',
            edges: 'Building references',
            index_verifying: 'Verifying reusable index',
            index_publishing: 'Validating and publishing index',
            dominators: 'Computing dominators'
        };
        var _progressActive = false;
        var _progressClock = null, _progressStartedAt = 0;
        function updateElapsed() {
            var el = document.getElementById('analysis-elapsed');
            if (el) el.textContent = Math.floor((Date.now() - _progressStartedAt) / 1000) + 's elapsed';
        }
        function beginProgress() {
            if (_progressActive) return;
            _progressActive = true; _progressStartedAt = Date.now();
            updateElapsed(); _progressClock = setInterval(updateElapsed, 1000);
        }
        function finishProgress() {
            if (_progressActive) updateElapsed();
            _progressActive = false;
            if (_progressClock !== null) clearInterval(_progressClock);
            _progressClock = null;
        }

        function renderProgressBar(stage, phase, totalPhases) {
            var bar = document.getElementById('progress-bar');
            if (!bar) return;
            beginProgress();
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

        onMessage('analysisStarting', function() { finishProgress(); renderProgressBar('starting', 1, 1); });
        onMessage('analysisProgress', function(msg) {
            if (msg.stage === 'cancelled') {
                finishProgress();
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
            } else if (_progressPhaseLabels[msg.stage]) {
                renderProgressBar(msg.stage, 1, 1);
            }
            if (msg.fileMetadata) {
                renderFileMetadata(msg.fileMetadata);
            }
            if (msg.summary) {
                renderHprofVersion(msg.summary);
            }
        });

        onMessage('analysisCancelled', function() {
            finishProgress();
            showProgressMessage(
                '<span style="opacity:0.7;">Analysis cancelled.</span> ' +
                '<button class="btn" id="progress-retry-btn" style="font-size:11px;padding:4px 10px;">Retry</button>'
            );
            var retryBtn = document.getElementById('progress-retry-btn');
            if (retryBtn) retryBtn.addEventListener('click', function() { vscode.postMessage({ command: 'retryAnalysis' }); });
        });

        onMessage('serverCrashed', function() {
            finishProgress();
            showProgressMessage(
                '<span style="color:var(--vscode-editorError-foreground);">Analysis server crashed.</span> ' +
                '<button class="btn" id="progress-retry-btn" style="font-size:11px;padding:4px 10px;">Retry</button>'
            );
            var retryBtn = document.getElementById('progress-retry-btn');
            if (retryBtn) retryBtn.addEventListener('click', function() { vscode.postMessage({ command: 'retryAnalysis' }); });
        });

        onMessage('analysisRetrying', function() {
            finishProgress(); beginProgress();
            showProgressMessage('<span style="opacity:0.7;">Retrying analysis...</span>');
        });

        onMessage('analysisFailed', function(msg) {
            finishProgress();
            showProgressMessage(
                '<span style="color:var(--vscode-editorError-foreground);">' + escapeHtml(msg.message || 'Analysis failed.') + '</span> ' +
                '<button class="btn" id="progress-retry-btn" style="font-size:11px;padding:4px 10px;">Retry</button>'
            );
            var retryBtn = document.getElementById('progress-retry-btn');
            if (retryBtn) retryBtn.addEventListener('click', function() { vscode.postMessage({ command: 'retryAnalysis' }); });
        });

        onMessage('shallowScanComplete', function() {
            finishProgress();
            document.getElementById('progress-bar').style.display = 'none';
        });
        onMessage('analysisComplete', function() {
            finishProgress();
            var bar = document.getElementById('progress-bar');
            if (bar) bar.style.display = 'none';
        });
    `;
}
