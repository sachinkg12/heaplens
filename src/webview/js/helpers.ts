export function getHelperJs(): string {
    return `
        // ---- Pure utility functions (no state, no side effects) ----

        function fmt(bytes) {
            if (bytes === 0) return '0 B';
            var k = 1024;
            var sizes = ['B', 'KB', 'MB', 'GB'];
            var i = Math.floor(Math.log(bytes) / Math.log(k));
            return (bytes / Math.pow(k, i)).toFixed(i > 1 ? 2 : 0) + ' ' + sizes[i];
        }

        function fmtNum(n) {
            return n.toLocaleString();
        }

        function escapeHtml(str) {
            var div = document.createElement('div');
            div.textContent = str;
            // Also safe inside double-quoted attributes; heap names are untrusted.
            return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function renderMarkdown(raw) {
            var html = escapeHtml(raw);

            // Fenced code blocks
            html = html.replace(/\\\`\\\`\\\`(\\w*)\\n([\\s\\S]*?)\\\`\\\`\\\`/g, function(_, lang, code) {
                var langCls = lang ? ' class="language-' + lang + '"' : '';
                return '<pre class="md-code-block" data-lang="' + (lang || '') + '"><code' + langCls + '>' + code.replace(/\\n$/, '') + '</code></pre>';
            });

            // Inline code
            html = html.replace(/\\\`([^\\\`]+)\\\`/g, '<code class="md-inline-code">$1</code>');

            // Bold
            html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');

            // Headings
            html = html.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>');
            html = html.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>');
            html = html.replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>');

            // Numbered list items
            html = html.replace(/^(\\d+)\\. (.+)$/gm, '<div class="md-li"><span class="md-li-num">$1.</span> $2</div>');

            // Bullet list items
            html = html.replace(/^- (.+)$/gm, '<div class="md-li"><span class="md-li-bullet">-</span> $1</div>');

            // Paragraphs (double newline)
            html = html.replace(/\\n\\n/g, '</p><p>');

            // Single newlines to <br>
            html = html.replace(/\\n/g, '<br>');

            return '<p>' + html + '</p>';
        }

        function isResolvableClass(className) {
            if (!className) return false;
            var primArrays = ['byte[]','short[]','int[]','long[]','float[]','double[]','char[]','boolean[]'];
            if (primArrays.indexOf(className) !== -1) return false;
            var prefixes = ['java.','javax.','sun.','com.sun.','jdk.'];
            for (var i = 0; i < prefixes.length; i++) {
                if (className.indexOf(prefixes[i]) === 0) return false;
            }
            return true;
        }

        function makeBadgeHtml(tier, dep) {
            var text, tooltip, cls;
            if (tier === 'workspace') {
                text = 'workspace';
                tooltip = 'Resolved from workspace source';
                cls = 'dep-badge workspace';
            } else {
                text = dep ? dep.artifactId + ':' + dep.version : tier;
                tooltip = dep ? dep.groupId + ':' + dep.artifactId + ':' + dep.version + ' (' + tier + ')' : tier;
                cls = 'dep-badge' + (tier === 'decompiled' ? ' decompiled' : '');
            }
            return '<span class="' + cls + '" title="' + escapeHtml(tooltip) + '">' + escapeHtml(text) + '</span>';
        }

        // ---- Shared cross-tab state ----
        // analysisData: set by orchestrator on analysisComplete, read by many tabs
        // depInfoCache: dependency resolution cache, written by source/helpers, read by tree/leaks

        var depInfoCache = {};

        function showError(message) {
            document.getElementById('stats-bar').innerHTML =
                '<div class="loading" style="color: var(--vscode-editorError-foreground);">Error: ' + escapeHtml(message) + '</div>';
        }

        var toastTimer = null;
        function showSourceToast(className) {
            var toast = document.getElementById('source-toast');
            toast.textContent = 'No source found for ' + className + '. Open a Java project with source files in this workspace.';
            toast.classList.add('visible');
            if (toastTimer) clearTimeout(toastTimer);
            toastTimer = setTimeout(function() { toast.classList.remove('visible'); }, 5000);
        }

        function updateDependencyBadges(className, tier, dep) {
            var badgeHtml = makeBadgeHtml(tier, dep);

            document.querySelectorAll('.go-to-source-link[data-class="' + className + '"]').forEach(function(link) {
                var existing = link.parentElement.querySelector('.dep-badge');
                if (existing) existing.remove();
                link.insertAdjacentHTML('afterend', badgeHtml);
            });

            document.querySelectorAll('.tree-row').forEach(function(row) {
                var nameEl = row.querySelector('.tree-name');
                if (nameEl && nameEl.textContent === className) {
                    var existing = row.querySelector('.dep-badge');
                    if (existing) existing.remove();
                    var sourceEl = row.querySelector('.tree-source');
                    if (sourceEl) {
                        sourceEl.insertAdjacentHTML('afterend', badgeHtml);
                    }
                }
            });
        }

        // ---- Self-register cross-cutting message handlers ----
        onMessage('error', function(msg) {
            showError(msg.message);
        });

        onMessage('dependencyResolved', function(msg) {
            depInfoCache[msg.className] = { tier: msg.tier, dependency: msg.dependency };
            updateDependencyBadges(msg.className, msg.tier, msg.dependency);
        });

        onMessage('sourceNotFound', function(msg) {
            showSourceToast(msg.className);
        });

        // ---- Fix with AI cross-cutting handlers ----
        onMessage('fixWithAiStarted', function(msg) {
            document.querySelectorAll('.fix-with-ai-link[data-class="' + msg.className + '"]').forEach(function(link) {
                link.textContent = 'Generating fix...';
                link.classList.add('disabled');
            });
            document.querySelectorAll('.source-fix-btn[data-class="' + msg.className + '"]').forEach(function(btn) {
                btn.textContent = 'Generating...';
                btn.disabled = true;
            });
            document.querySelectorAll('.tree-fix[data-class="' + msg.className + '"]').forEach(function(el) {
                el.style.opacity = '0.3';
                el.style.pointerEvents = 'none';
            });
        });

        onMessage('fixWithAiDone', function(msg) {
            if (msg.status === 'already-fixed') {
                document.querySelectorAll('.fix-with-ai-link[data-class="' + msg.className + '"]').forEach(function(link) {
                    link.textContent = 'Already Fixed \\u2714';
                    link.classList.add('fixed');
                    link.classList.remove('disabled');
                });
                document.querySelectorAll('.source-fix-btn[data-class="' + msg.className + '"]').forEach(function(btn) {
                    btn.textContent = 'Already Fixed \\u2714';
                    btn.disabled = true;
                    btn.classList.add('fixed');
                });
                document.querySelectorAll('.tree-fix[data-class="' + msg.className + '"]').forEach(function(el) {
                    el.textContent = '\\u2714';
                    el.style.opacity = '0.6';
                    el.style.pointerEvents = 'none';
                    el.title = 'Already fixed';
                });
            } else {
                document.querySelectorAll('.fix-with-ai-link[data-class="' + msg.className + '"]').forEach(function(link) {
                    link.textContent = 'Fix with AI';
                    link.classList.remove('disabled');
                });
                document.querySelectorAll('.source-fix-btn[data-class="' + msg.className + '"]').forEach(function(btn) {
                    btn.textContent = 'Fix with AI';
                    btn.disabled = false;
                });
                document.querySelectorAll('.tree-fix[data-class="' + msg.className + '"]').forEach(function(el) {
                    el.style.opacity = '';
                    el.style.pointerEvents = '';
                });
            }
        });

        onMessage('fixWithAiError', function(msg) {
            document.querySelectorAll('.fix-with-ai-link[data-class="' + msg.className + '"]').forEach(function(link) {
                link.textContent = 'Fix with AI';
                link.classList.remove('disabled');
            });
            document.querySelectorAll('.source-fix-btn[data-class="' + msg.className + '"]').forEach(function(btn) {
                btn.textContent = 'Fix with AI';
                btn.disabled = false;
            });
            document.querySelectorAll('.tree-fix[data-class="' + msg.className + '"]').forEach(function(el) {
                el.style.opacity = '';
                el.style.pointerEvents = '';
            });
        });

        onMessage('classFixed', function(msg) {
            document.querySelectorAll('.fix-with-ai-link[data-class="' + msg.className + '"]').forEach(function(link) {
                link.textContent = 'Fixed \\u2714';
                link.classList.add('fixed');
            });
            document.querySelectorAll('.source-fix-btn[data-class="' + msg.className + '"]').forEach(function(btn) {
                btn.textContent = 'Fixed \\u2714';
                btn.disabled = true;
                btn.classList.add('fixed');
            });
            document.querySelectorAll('.tree-fix[data-class="' + msg.className + '"]').forEach(function(el) {
                el.textContent = '\\u2714';
                el.style.opacity = '0.6';
                el.style.pointerEvents = 'none';
                el.title = 'Fixed';
            });
        });
    `;
}
