var comparisonSequence=0,comparisonPending=null;
function comparisonSend(message){
    if(message.command==='compareHeaps'){
        if(!objectReady){renderCompareError('Wait for analysis or Retry first.');return;}
        comparisonPending='compare-'+(++comparisonSequence);message.requestId=comparisonPending;
    }
    send(message);
}
function resetComparison(){
    comparisonPending=null;_lastCompareResult=null;
    _compareResults.textContent='';_compareExportMdBtn.style.display='none';_compareExportCsvBtn.style.display='none';
    _compareBtn.disabled=!objectReady || !_compareSelect.value;
    _compareStatus.textContent='Analyzed dumps changed. Select a baseline and compare again.';
}
listen('snapshotsChanged',function(){resetComparison();send({command:'listAnalyzedFiles'});});
listen('analysisProgress',function(m){if(m.stage==='loading')resetComparison();});
listen('analysisCancelled',resetComparison);listen('serverCrashed',resetComparison);
