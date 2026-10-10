// Private host boundary around the unchanged tree renderer. No Query/Histogram events.
var dominatorReady = false;
var dominatorHeap = null;
var dominatorSequence = 0;
var dominatorPending = new Map();
var dominatorStatus = document.getElementById('dominator-status');
var dominatorReset = document.getElementById('reset-tree-btn');
dominatorReset.disabled = true;

function dominatorRows(objectId) {
    return _domTreeContainer.querySelectorAll('.tree-row[data-object-id="' + objectId + '"]');
}
function validDominatorNode(node) {
    return node && Number.isSafeInteger(node.object_id) && node.object_id > 0 &&
        ['Instance', 'Array', 'Class', 'SuperRoot'].includes(node.node_type) &&
        (node.class_name == null || typeof node.class_name === 'string') &&
        Number.isFinite(node.shallow_size) && node.shallow_size >= 0 &&
        Number.isFinite(node.retained_size) && node.retained_size >= 0 &&
        (node.field_name == null || typeof node.field_name === 'string');
}
function dominatorError(objectId, text) {
    dominatorPending.delete(objectId);
    dominatorStatus.textContent = text;
    dominatorRows(objectId).forEach(function(row) {
        row.querySelector('.tree-toggle').textContent = '\u25B6';
        row.setAttribute('aria-expanded', 'false');
        row.removeAttribute('aria-busy');
    });
}
function requestDominatorChildren(message) {
    if (message.command !== 'getChildren') { send(message); return; }
    var id = message.objectId;
    if (!dominatorReady || !Number.isSafeInteger(id) || id <= 0) return;
    if (dominatorPending.has(id)) return;
    dominatorStatus.textContent = '';
    var requestId = 'dominator-' + (++dominatorSequence);
    dominatorPending.set(id, requestId);
    dominatorRows(id).forEach(function(row) { row.setAttribute('aria-busy', 'true'); });
    send({ command: 'dominatorChildren', objectId: id, requestId: requestId });
}
function currentDominatorReply(message) {
    return dominatorReady && dominatorPending.has(message.objectId) &&
        dominatorPending.get(message.objectId) === message.requestId;
}
function acceptDominatorReply(message) {
    if (!currentDominatorReply(message)) return false;
    if (!Array.isArray(message.children) ||
        !message.children.every(function(node) { return validDominatorNode(node) && node.object_id !== message.objectId; })) {
        dominatorError(message.objectId, 'Invalid children response. Expand the row to retry.');
        return false;
    }
    dominatorPending.delete(message.objectId);
    return true;
}
function finishDominatorExpansion(objectId) {
    dominatorRows(objectId).forEach(function(row) {
        row.removeAttribute('aria-busy');
        if (row.classList.contains('leaf')) row.removeAttribute('aria-expanded');
    });
}
listen('dominatorChildrenError', function(message) {
    if (currentDominatorReply(message))
        dominatorError(message.objectId, message.error || 'Could not load children. Expand the row to retry.');
});

// Keep shared layout/actions and supply the full reachable-heap denominator.
var sharedDominatorRow = createTreeRow;
createTreeRow = function(obj, depth) {
    var knownHeap = typeof dominatorHeap === 'number' && Number.isFinite(dominatorHeap) && dominatorHeap > 0;
    _totalRetained = knownHeap ? dominatorHeap : 0;
    var row = sharedDominatorRow(obj, depth);
    var pct = row.querySelector('.tree-pct');
    pct.setAttribute('title', 'Retained size as a percentage of reachable heap');
    if (!knownHeap) {
        pct.textContent = 'N/A';
        row.querySelector('.tree-bar').style.width = '0%';
    }
    row.setAttribute('tabindex', '0');
    row.setAttribute('title', 'Object ID: ' + obj.object_id + ' (0x' + obj.object_id.toString(16) + ')');
    if(typeof updateFixAvailability==='function') updateFixAvailability(row);
    return row;
};
var sharedDominatorRender = renderDominatorTree;
renderDominatorTree = function(layers) {
    dominatorPending.clear(); // Back to Root must also retire outstanding child replies.
    dominatorStatus.textContent = '';
    var displayable = Array.isArray(layers) ? layers.filter(function(node) {
        return !node || (node.node_type !== 'Class' && node.node_type !== 'SuperRoot');
    }) : [];
    var valid = displayable.filter(validDominatorNode);
    if (!Array.isArray(layers) || valid.length !== displayable.length)
        dominatorStatus.textContent = 'Some tree entries are unavailable or have unsupported object IDs.';
    sharedDominatorRender(valid);
    if (!_treeData.length) _domTreeContainer.textContent = 'No displayable retained entry points in this analysis.';
};
function resetDominator(text) {
    dominatorReady = false;
    dominatorPending.clear();
    dominatorHeap = null;
    _treeData = [];
    _tabRendered.domtree = true; // Do not lazily revive the last analysis after a crash.
    dominatorReset.disabled = true;
    dominatorReset.style.display = 'none';
    document.getElementById('domtree-header').style.display = 'none';
    _domTreeContainer.textContent = text;
    dominatorStatus.textContent = '';
}
listen('analysisProgress', function(message) {
    if (message.stage === 'loading') resetDominator('Waiting for analysis...');
});
listen('serverCrashed', function() { resetDominator('Analysis server unavailable. Use Retry above.'); });
listen('analysisCancelled', function() { resetDominator('Analysis cancelled. Use Retry above.'); });
listen('analysisComplete', function() {
    dominatorReady = true;
    dominatorReset.disabled = false;
});
