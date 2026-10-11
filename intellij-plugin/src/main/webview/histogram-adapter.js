// Runs inside the shared Histogram renderer's private scope. It adapts transport
// and lifecycle only; sorting, filtering and both tables remain shared code.
var histogramReady = false;
var histogramSequence = 0;
var histogramPending = null;
var histogramPanel = document.getElementById('histogram-instances-panel');
var histogramSearch = document.getElementById('histogram-search');
histogramSearch.disabled = true;

function histogramStatus(text) {
    histogramPending = null;
    _pendingInstanceClass = null;
    histogramPanel.textContent = text;
}

function requestHistogramInstances(message) {
    if (message.command !== 'executeQuery') { send(message); return; }
    if (!_pendingInstanceClass) return;
    if (!histogramReady) {
        histogramStatus('Wait for analysis to finish. Use Retry above if the server is unavailable.');
        return;
    }
    histogramPending = { requestId: 'histogram-' + (++histogramSequence), className: _pendingInstanceClass };
    send({ command: 'histogramInstances', requestId: histogramPending.requestId, className: histogramPending.className });
}

function isCurrentHistogramReply(message) {
    return histogramReady && histogramPending &&
        message.requestId === histogramPending.requestId && message.className === histogramPending.className;
}

function acceptHistogramResult(message) {
    if (!isCurrentHistogramReply(message)) return false;
    if (!message.result || !Array.isArray(message.result.columns) || !Array.isArray(message.result.rows)) {
        histogramStatus('Invalid instance response. Select the class to try again.');
        return false;
    }
    histogramPending = null;
    return true; // The shared handler renders, then clears _pendingInstanceClass.
}

var sharedInstancePanel = renderInstancePanel;
renderInstancePanel = function (className, result) {
    sharedInstancePanel(className, result);
    var hint = document.createElement('div');
    hint.className = 'histogram-hint';
    hint.textContent = 'Preview: up to 200 instances, ordered by retained size. Use Query for other limits.';
    histogramPanel.appendChild(hint);
};

listen('histogramInstancesError', function (message) {
    if (isCurrentHistogramReply(message)) histogramStatus(message.error || 'Could not load instances. Select the class to retry.');
});
function resetHistogram(text) {
    histogramReady = false;
    histogramSearch.disabled = true;
    document.getElementById('histogram-table').textContent = text;
    histogramStatus('');
}
listen('analysisProgress', function (message) {
    if (message.stage === 'loading') resetHistogram('Waiting for analysis...');
});
listen('serverCrashed', function () { resetHistogram('Analysis server unavailable. Use Retry above.'); });
listen('analysisCancelled', function () { resetHistogram('Analysis cancelled. Use Retry above.'); });
listen('analysisComplete', function () {
    histogramReady = true;
    histogramSearch.disabled = false;
});
