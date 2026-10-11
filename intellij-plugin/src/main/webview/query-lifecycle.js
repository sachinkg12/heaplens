// IntelliJ-only lifecycle adapter for the unchanged shared HeapQL renderer.
// A server failure is not a query syntax error; its status ends on recovery.
(function () {
    var recoveringServer = false;
    var status = document.getElementById('query-status');

    function showStatus(message) {
        status.className = 'query-status';
        status.textContent = message;
    }

    onMessage('serverCrashed', function () {
        recoveringServer = true;
        renderQueryError('Analysis server unavailable. Use Retry above.');
    });
    onMessage('analysisProgress', function (msg) {
        if (recoveringServer && msg.stage === 'loading') {
            showStatus('Reanalyzing heap. Wait for analysis to complete.');
        }
    });
    onMessage('analysisCancelled', function () {
        if (recoveringServer) showStatus('Analysis cancelled. Use Retry above.');
    });
    onMessage('analysisComplete', function () {
        if (!recoveringServer) return;
        recoveringServer = false;
        showStatus('');
    });
})();
