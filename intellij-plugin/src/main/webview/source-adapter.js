// Project-source capability around the shared table. No AI, dependency download or arbitrary paths.
var sourceReady = false;
var sourceSequence = 0;
var sourcePending = null;
var sourceStatus = document.getElementById('source-status');
var sourceSearch = document.getElementById('source-search');
var sourceLabels = {
    searching: 'Looking in this project…', indexing: 'Waiting for project indexing…',
    opened: 'Opened project source', 'opened-read-only':'Opened project source (AI Fix unavailable)', 'dependency-source':'Opened attached dependency source', decompiled:'Opened IDE decompiler',
    'not-found': 'No matching project or attached dependency source/class',
    cancelled: 'Selection cancelled', 'too-many': 'Too many matches; narrow the project scope',
    error: 'Source lookup failed; try again', busy: 'Another lookup is in progress',
    unavailable: 'Analysis unavailable; retry the heap analysis first'
};
sourceSearch.disabled = true;
_srcStatusMap = Object.create(null);

function isProjectSourceClass(name) {
    if (typeof name !== 'string' || !name || name.length > 1024) return false;
    var base = name.replace(/^class /, '').replace(/(?:\[\])+$/, '');
    if (/^(boolean|byte|char|short|int|long|float|double|void)$/.test(base.split('.').at(-1))) return false;
    return base.split('.').every(function(part) {
        return /^[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}]*$/u.test(part);
    });
}

// Keep the shared table/formatters but bound rendering. Filtering still searches all eligible classes.
var sharedSourceTable = renderSourceTable;
renderSourceTab = function(histogram) {
    sourceReady = true; sourceSearch.disabled = false;
    var seen = new Set();
    _srcHistogram = histogram.filter(function(entry) {
        if (!isProjectSourceClass(entry.class_name) || seen.has(entry.class_name)) return false;
        seen.add(entry.class_name); return true;
    });
    renderSourceTable();
};
renderSourceTable = function() {
    if (!sourceReady) return;
    var all = _srcHistogram, filter = _srcFilter;
    var matching = all.filter(function(entry) { return entry.class_name.toLowerCase().includes(filter.toLowerCase()); });
    matching.sort(function(a,b) {
        var left = a[_srcSortCol], right = b[_srcSortCol];
        var order = typeof left === 'string' ? left.localeCompare(right) : left - right;
        return _srcSortAsc ? order : -order;
    });
    _srcHistogram = matching.slice(0,200); _srcFilter = '';
    try { sharedSourceTable(); }
    finally { _srcHistogram = all; _srcFilter = filter; }
    var container = document.getElementById('source-table');
    container.querySelectorAll('tr[data-source-class]').forEach(function(row) {
        var name = row.dataset.sourceClass;
        var cells = row.querySelectorAll('td');
        cells[3].textContent = sourceLabels[_srcStatusMap[name]] || '';
        var original = row.querySelector('.source-view-btn');
        // The shared button is one-shot. Host navigation must allow reopening a found file.
        var button = original.cloneNode(true); original.replaceWith(button);
        button.disabled = !!sourcePending;
        button.textContent = ['opened','opened-read-only','dependency-source','decompiled'].includes(_srcStatusMap[name]) ? 'Open Again' : 'View Source';
        button.addEventListener('click', function() {
            if (!sourceReady || sourcePending) return;
            var requestId = 'source-' + (++sourceSequence);
            sourcePending = {className:name, requestId:requestId};
            _srcStatusMap[name] = 'searching'; sourceStatus.textContent = sourceLabels.searching;
            renderSourceTable();
            send({command:'openProjectSource', className:name, requestId:requestId});
        });
    });
    if(typeof updateFixAvailability==='function') updateFixAvailability(container);
    var opened = all.filter(function(entry) { return ['opened','opened-read-only'].includes(_srcStatusMap[entry.class_name]); }).length;
    document.getElementById('source-stats').textContent = 'Showing ' + Math.min(matching.length,200) +
        ' of ' + matching.length + ' matching classes · ' + opened + ' opened locally' +
        (matching.length > 200 ? ' · Filter to find other classes' : '');
};

listen('sourceNavigationResult', function(message) {
    if (!sourceReady || !sourcePending || message.className !== sourcePending.className ||
        message.requestId !== sourcePending.requestId) return;
    var status = Object.prototype.hasOwnProperty.call(sourceLabels, message.status) ? message.status : 'error';
    _srcStatusMap[message.className] = status;
    sourceStatus.textContent = sourceLabels[status];
    if (status !== 'indexing' && status !== 'searching') sourcePending = null;
    renderSourceTable();
});
function clearProjectSource(text) {
    sourceReady = false; sourcePending = null; _srcHistogram = []; _srcStatusMap = Object.create(null);
    _tabRendered.source = true;
    sourceSearch.disabled = true;
    document.getElementById('source-table').textContent = text;
    document.getElementById('source-stats').textContent = '';
    sourceStatus.textContent = '';
}
listen('analysisProgress', function(message) {
    if (message.stage === 'loading') clearProjectSource('Waiting for analysis…');
});
listen('serverCrashed', function() { clearProjectSource('Analysis unavailable. Retry before opening source.'); });
listen('analysisCancelled', function() { clearProjectSource('Analysis cancelled. Retry to load source classes.'); });
listen('analysisComplete', function() { sourceReady = true; sourceSearch.disabled = false; });
