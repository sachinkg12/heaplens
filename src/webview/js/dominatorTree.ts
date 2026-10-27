export function getDominatorTreeJs(): string {
    return `
        // ---- Tab 3: Dominator Tree ----
        // Self-contained: owns tree state + expand/collapse + rendering.
        // Sibling cap: shows 50 at a time with "Show more" button.

        var _treeData = [];
        var _reachableHeap = null;
        var TREE_SIBLING_CAP = 50;
        var PRIMITIVE_ARRAYS = ['byte[]', 'short[]', 'int[]', 'long[]', 'float[]', 'double[]', 'char[]', 'boolean[]'];

        function isLeafType(obj) {
            return PRIMITIVE_ARRAYS.indexOf(obj.class_name) !== -1;
        }

        function renderDominatorTree(layers, reachableHeap) {
            _treeData = layers.filter(function(o) { return o.node_type !== 'Class' && o.node_type !== 'SuperRoot' && o.retained_size > 0; });
            // Top layers overlap along ownership chains. Their retained sizes
            // must never be summed to form a denominator.
            _reachableHeap = typeof reachableHeap === 'number' && Number.isFinite(reachableHeap) && reachableHeap > 0 ? reachableHeap : null;

            document.getElementById('domtree-header').style.display = _treeData.length > 0 ? 'block' : 'none';
            document.getElementById('reset-tree-btn').style.display = _treeData.length > 0 ? 'inline-block' : 'none';

            var container = document.getElementById('dominator-tree');
            container.innerHTML = '';
            container.setAttribute('role', 'tree');
            container.setAttribute('aria-label', 'Dominator tree');
            appendCappedChildren(container, _treeData, 0);
        }

        function appendCappedChildren(container, children, depth) {
            var visible = children.slice(0, TREE_SIBLING_CAP);
            var remaining = children.length - TREE_SIBLING_CAP;

            visible.forEach(function(obj) { container.appendChild(createTreeRow(obj, depth)); });

            if (remaining > 0) {
                appendShowMoreButton(container, children, TREE_SIBLING_CAP, depth);
            }
        }

        function appendShowMoreButton(container, allChildren, startIdx, depth) {
            var remaining = allChildren.length - startIdx;
            var btn = document.createElement('div');
            btn.className = 'tree-show-more';
            btn.style.paddingLeft = (12 + depth * 20) + 'px';
            btn.textContent = 'Show ' + Math.min(TREE_SIBLING_CAP, remaining) + ' more... (' + remaining + ' remaining)';
            btn.addEventListener('click', function() {
                btn.remove();
                var nextBatch = allChildren.slice(startIdx, startIdx + TREE_SIBLING_CAP);
                nextBatch.forEach(function(obj) { container.appendChild(createTreeRow(obj, depth)); });
                var newRemaining = allChildren.length - (startIdx + TREE_SIBLING_CAP);
                if (newRemaining > 0) {
                    appendShowMoreButton(container, allChildren, startIdx + TREE_SIBLING_CAP, depth);
                }
            });
            container.appendChild(btn);
        }

        function createTreeRow(obj, depth) {
            var leaf = isLeafType(obj);
            var row = document.createElement('div');
            row.className = 'tree-row' + (leaf ? ' leaf' : ' expandable');
            row.style.paddingLeft = (12 + depth * 20) + 'px';
            row.dataset.objectId = obj.object_id;
            row.dataset.depth = depth;
            row.setAttribute('role', 'treeitem');
            row.setAttribute('aria-level', String(depth + 1));
            row.setAttribute('tabindex', '-1');
            if (!leaf) row.setAttribute('aria-expanded', 'false');

            var pct = _reachableHeap !== null && Number.isFinite(obj.retained_size) && obj.retained_size >= 0
                ? ((obj.retained_size / _reachableHeap) * 100) : null;
            if (!Number.isFinite(pct)) pct = null;
            var pctStr = pct === null ? 'N/A' : pct.toFixed(1) + '%';
            var barWidth = pct === null ? 0 : Math.max(1, Math.min(100, pct));
            var displayName = obj.class_name || obj.node_type;
            var typeCls = obj.node_type === 'Array' ? 'array' : 'instance';
            var showSource = (obj.node_type === 'Instance' || obj.node_type === 'Array') && isResolvableClass(displayName);
            var cachedDep = depInfoCache[displayName];
            var depBadge = cachedDep ? makeBadgeHtml(cachedDep.tier, cachedDep.dependency) : '';
            var showPin = obj.object_id > 0;
            var showInspect = obj.node_type === 'Instance' && obj.object_id > 0;
            var showRefs = obj.object_id > 0;
            var fieldNameHtml = obj.field_name ? '<span class="tree-field-name">' + escapeHtml(obj.field_name) + ' =</span>' : '';

            row.innerHTML =
                '<span class="tree-toggle">' + (leaf ? '' : '\\u25B6') + '</span>' +
                fieldNameHtml +
                '<span class="tree-name">' + escapeHtml(displayName) + '</span>' +
                '<span class="tree-type ' + typeCls + '">' + obj.node_type + '</span>' +
                '<span class="tree-shallow">' + fmt(obj.shallow_size) + '</span>' +
                '<span class="tree-size">' + fmt(obj.retained_size) + '</span>' +
                '<span class="tree-bar-wrap"><div class="tree-bar" style="width:' + barWidth + '%"></div></span>' +
                '<span class="tree-pct" title="Retained size as a percentage of reachable heap. Nested entries can overlap.">' + pctStr + '</span>' +
                '<span class="tree-actions">' +
                '<span class="tree-action-slot tree-action-alive">' + (showPin ? '<button class="why-alive-btn" title="Show GC root path">Why alive?</button>' : '') + '</span>' +
                '<span class="tree-action-slot tree-action-icon">' + (showInspect ? '<span class="tree-inspect" role="button" aria-label="Inspect fields for ' + escapeHtml(displayName) + '" title="Inspect fields">\\uD83D\\uDD0D</span>' : '') + '</span>' +
                '<span class="tree-action-slot tree-action-icon">' + (showSource ? '<span class="tree-source" role="button" aria-label="Go to source for ' + escapeHtml(displayName) + '" title="Go to source">\\u2197</span>' : '') + '</span>' +
                '<span class="tree-action-slot tree-action-icon">' + (showSource ? '<span class="tree-fix" role="button" data-class="' + escapeHtml(displayName) + '" aria-label="Fix with AI for ' + escapeHtml(displayName) + '" title="Fix with AI">\\uD83D\\uDD27</span>' : '') + '</span>' +
                '<span class="tree-action-slot tree-action-icon">' + (showRefs ? '<span class="tree-refs" role="button" aria-label="Show referrers for ' + escapeHtml(displayName) + '" title="Show referrers">\\u2190</span>' : '') + '</span>' +
                depBadge +
                '</span>';

            if (!leaf) {
                row.addEventListener('click', function() {
                    var toggle = row.querySelector('.tree-toggle');
                    var childContainer = row.nextElementSibling;
                    if (childContainer && childContainer.classList.contains('tree-children')) {
                        var isHidden = childContainer.style.display === 'none';
                        childContainer.style.display = isHidden ? 'block' : 'none';
                        toggle.textContent = isHidden ? '\\u25BC' : '\\u25B6';
                        row.setAttribute('aria-expanded', String(isHidden));
                    } else if (toggle.textContent !== '\\u00B7') {
                        toggle.textContent = '\\u23F3';
                        vscode.postMessage({ command: 'getChildren', objectId: obj.object_id });
                    }
                });
            }

            if (showPin) {
                row.querySelector('.why-alive-btn').addEventListener('click', function(e) {
                    e.stopPropagation();
                    vscode.postMessage({ command: 'gcRootPath', objectId: obj.object_id });
                });
            }

            if (showInspect) {
                row.querySelector('.tree-inspect').addEventListener('click', function(e) {
                    e.stopPropagation();
                    openInspector(obj.object_id, displayName, obj.shallow_size, obj.retained_size);
                });
            }

            if (showSource) {
                row.querySelector('.tree-source').addEventListener('click', function(e) {
                    e.stopPropagation();
                    vscode.postMessage({ command: 'goToSource', className: displayName });
                });

                row.querySelector('.tree-fix').addEventListener('click', function(e) {
                    e.stopPropagation();
                    vscode.postMessage({
                        command: 'fixWithAi',
                        className: displayName,
                        retainedSize: obj.retained_size,
                        retainedPercentage: pct,
                        description: 'Object ' + displayName + ' retaining ' + fmt(obj.retained_size) + ' in dominator tree'
                    });
                });
            }

            if (showRefs) {
                row.querySelector('.tree-refs').addEventListener('click', function(e) {
                    e.stopPropagation();
                    vscode.postMessage({ command: 'getReferrers', objectId: obj.object_id });
                    // Store context for rendering
                    window._pendingRefsContext = { objectId: obj.object_id, className: displayName };
                });
            }

            return row;
        }

        function expandTreeNode(objectId, children) {
            var rows = document.querySelectorAll('.tree-row[data-object-id="' + objectId + '"]');
            rows.forEach(function(row) {
                var toggle = row.querySelector('.tree-toggle');
                var existing = row.nextElementSibling;
                if (existing && existing.classList.contains('tree-children')) existing.remove();

                var depth = parseInt(row.dataset.depth || '0') + 1;
                var filtered = children.filter(function(c) { return c.node_type !== 'Class' && c.retained_size > 0; });

                if (filtered.length === 0) {
                    toggle.textContent = '\\u00B7';
                    row.classList.remove('expandable');
                    row.classList.add('leaf');
                    return;
                }

                toggle.textContent = '\\u25BC';
                row.setAttribute('aria-expanded', 'true');
                var childContainer = document.createElement('div');
                childContainer.className = 'tree-children';
                childContainer.setAttribute('role', 'group');
                appendCappedChildren(childContainer, filtered, depth);
                row.after(childContainer);
            });
        }

        function markLeaf(objectId) {
            var rows = document.querySelectorAll('.tree-row[data-object-id="' + objectId + '"]');
            rows.forEach(function(row) {
                row.querySelector('.tree-toggle').textContent = '\\u00B7';
                row.classList.remove('expandable');
                row.classList.add('leaf');
            });
        }

        // ---- Self-register ----
        function retireDominatorPercentage() {
            _reachableHeap = null;
            _treeData = [];
            document.getElementById('dominator-tree').innerHTML = '';
            document.getElementById('domtree-header').style.display = 'none';
            document.getElementById('reset-tree-btn').style.display = 'none';
        }
        ['analysisStarting', 'analysisCancelled', 'analysisFailed', 'serverCrashed'].forEach(function(command) {
            onMessage(command, retireDominatorPercentage);
        });
        onTabMessage('domtree', 'analysisComplete', function(msg) {
            renderDominatorTree(msg.topLayers || [], msg.summary && msg.summary.reachable_heap_size);
        });

        onMessage('childrenResponse', function(msg) {
            expandTreeNode(msg.objectId, msg.children);
        });

        onMessage('noChildren', function(msg) {
            markLeaf(msg.objectId);
        });

        document.getElementById('reset-tree-btn').addEventListener('click', function() {
            if (analysisData) renderDominatorTree(analysisData.topLayers || [], analysisData.summary && analysisData.summary.reachable_heap_size);
        });

        function renderReferrersOverlay(objectId, className, referrers) {
            var container = document.getElementById('gc-path-container');
            if (!referrers || referrers.length === 0) {
                container.innerHTML = '<div class="referrers-overlay"><div class="referrers-header"><span class="referrers-title">Referrers to ' + escapeHtml(className) + '</span><button class="gc-path-close">&times;</button></div><div style="padding:12px;opacity:0.5;font-size:12px;">No referrers found (this is a GC root)</div></div>';
                container.querySelector('.gc-path-close').addEventListener('click', function() { container.innerHTML = ''; });
                return;
            }
            var html = '<div class="referrers-overlay"><div class="referrers-header"><span class="referrers-title">Referrers to ' + escapeHtml(className) + ' (' + referrers.length + ')</span><button class="gc-path-close">&times;</button></div>';
            html += '<div class="referrers-list">';
            referrers.forEach(function(ref) {
                var refName = ref.class_name || ref.node_type;
                var fieldHtml = ref.field_name ? '<span class="referrer-field">' + escapeHtml(ref.field_name) + '</span> \\u2192 ' : '';
                html += '<div class="referrer-row" data-object-id="' + ref.object_id + '" data-class="' + escapeHtml(refName) + '" data-shallow="' + ref.shallow_size + '" data-retained="' + ref.retained_size + '">' +
                    fieldHtml +
                    '<span class="referrer-class">' + escapeHtml(refName) + '</span>' +
                    '<span class="referrer-type">' + ref.node_type + '</span>' +
                    '<span class="referrer-size">' + fmt(ref.retained_size) + '</span>' +
                    '<span class="referrer-actions">' +
                    (ref.node_type === 'Instance' && ref.object_id > 0 ? '<span class="tree-inspect referrer-action" title="Inspect fields">\\uD83D\\uDD0D</span>' : '') +
                    (ref.object_id > 0 ? '<span class="tree-refs referrer-action" title="Show referrers">\\u2190</span>' : '') +
                    '</span>' +
                    '</div>';
            });
            html += '</div></div>';
            container.innerHTML = html;
            container.querySelector('.gc-path-close').addEventListener('click', function() { container.innerHTML = ''; });

            container.querySelectorAll('.referrer-row .tree-inspect').forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var row = btn.closest('.referrer-row');
                    openInspector(parseInt(row.dataset.objectId), row.dataset.class, parseInt(row.dataset.shallow), parseInt(row.dataset.retained));
                });
            });

            container.querySelectorAll('.referrer-row .tree-refs').forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var row = btn.closest('.referrer-row');
                    var refId = parseInt(row.dataset.objectId);
                    var refClass = row.dataset.class;
                    window._pendingRefsContext = { objectId: refId, className: refClass };
                    vscode.postMessage({ command: 'getReferrers', objectId: refId });
                });
            });
        }

        onMessage('referrersResponse', function(msg) {
            var ctx = window._pendingRefsContext || {};
            renderReferrersOverlay(msg.objectId, ctx.className || ('Object #' + msg.objectId), msg.referrers);
            window._pendingRefsContext = null;
        });

        // ---- Keyboard navigation for dominator tree ----
        function getNextVisibleRow(row) {
            var next = row.nextElementSibling;
            if (next && next.classList.contains('tree-children') && next.style.display !== 'none') {
                var firstChild = next.querySelector('.tree-row');
                if (firstChild) return firstChild;
                next = next.nextElementSibling;
            }
            if (next && next.classList.contains('tree-row')) return next;
            if (next && next.classList.contains('tree-show-more')) return next;
            // Walk up to find next sibling of parent container
            var parent = row.parentElement;
            while (parent && parent.id !== 'dominator-tree') {
                var parentNext = parent.nextElementSibling;
                if (parentNext && parentNext.classList.contains('tree-row')) return parentNext;
                if (parentNext && parentNext.classList.contains('tree-show-more')) return parentNext;
                parent = parent.parentElement;
            }
            return null;
        }

        function getPrevVisibleRow(row) {
            var prev = row.previousElementSibling;
            if (!prev) {
                var parent = row.parentElement;
                if (parent && parent.classList.contains('tree-children')) {
                    var parentRow = parent.previousElementSibling;
                    if (parentRow && parentRow.classList.contains('tree-row')) return parentRow;
                }
                return null;
            }
            if (prev.classList.contains('tree-children') && prev.style.display !== 'none') {
                var rows = prev.querySelectorAll('.tree-row, .tree-show-more');
                if (rows.length > 0) return rows[rows.length - 1];
            }
            if (prev.classList.contains('tree-children')) {
                prev = prev.previousElementSibling;
            }
            if (prev && (prev.classList.contains('tree-row') || prev.classList.contains('tree-show-more'))) return prev;
            return null;
        }

        var _domTreeContainer = document.getElementById('dominator-tree');
        _domTreeContainer.addEventListener('keydown', function(e) {
            var row = e.target.closest('.tree-row, .tree-show-more');
            if (!row) return;
            var target = null;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                target = getNextVisibleRow(row);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                target = getPrevVisibleRow(row);
            } else if (e.key === 'ArrowRight' && row.classList.contains('tree-row')) {
                e.preventDefault();
                var expanded = row.getAttribute('aria-expanded');
                if (expanded === 'true') {
                    var childContainer = row.nextElementSibling;
                    if (childContainer && childContainer.classList.contains('tree-children')) {
                        var firstChild = childContainer.querySelector('.tree-row');
                        if (firstChild) target = firstChild;
                    }
                } else if (expanded === 'false') {
                    row.click();
                }
            } else if (e.key === 'ArrowLeft' && row.classList.contains('tree-row')) {
                e.preventDefault();
                var expanded = row.getAttribute('aria-expanded');
                if (expanded === 'true') {
                    row.click();
                } else {
                    var parent = row.parentElement;
                    if (parent && parent.classList.contains('tree-children')) {
                        var parentRow = parent.previousElementSibling;
                        if (parentRow && parentRow.classList.contains('tree-row')) target = parentRow;
                    }
                }
            } else if (e.key === 'Enter' || e.key === ' ') {
                if (row.classList.contains('expandable') || row.classList.contains('tree-show-more')) {
                    e.preventDefault();
                    row.click();
                }
            }
            if (target) {
                row.setAttribute('tabindex', '-1');
                target.setAttribute('tabindex', '0');
                target.focus();
            }
        });
    `;
}
