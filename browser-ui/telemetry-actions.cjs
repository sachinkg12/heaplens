'use strict';
// Focused optional observer: no engine objects, IDs or event bodies cross its sink.
function observe(session, command, data) {
    const telemetry=session.host.telemetry;
    if (!telemetry || session.state==='closed') return;
    const state=session.diagnosticState ||= {generation:-1,phase:'unknown',completed:-1};
    if(command==='analysisProgress') {
        if(state.generation!==session.generation) {
            state.generation=session.generation;state.started=Date.now();
            telemetry.track('analysis/started',{}, {fileSizeMB:session.file.size/1048576});
        }
        const phase=['loading','graph_building','graph_built','dominators'].includes(data.stage)?data.stage:'unknown';
        if(phase!==state.phase){state.phase=phase;telemetry.track('analysis/phase',{phase});}
    } else if(command==='analysisComplete' && state.completed!==session.generation) {
        state.completed=session.generation;
        const summary=data.summary||{};
        telemetry.track('analysis/completed',{}, {durationMs:Math.min(86400000,Date.now()-state.started),objectCount:summary.total_instances||0,
            classCount:summary.total_classes||0,heapSizeMB:(summary.total_heap_size||0)/1048576});
    } else if(command==='serverCrashed') {
        telemetry.track('error/serverCrashed',{phase:state.phase,errorType:'unknown'});
    } else if(command==='analysisCancelled') telemetry.track('analysis/cancelled');
    else if(command==='queryError') telemetry.track('query/failed',{phase:'query',errorType:'unknown'});
    else if(command==='queryResult') telemetry.track('feature/queryExecuted');
}
function install(session) {
    const actions={aiSend:'feature/chatMessage',openProjectSource:'feature/goToSource',fixWithAi:'feature/fixWithAi',explainObject:'feature/explainObject',
        explainLeakSuspect:'feature/explainLeakSuspect',inspectObject:'feature/inspectObject',gcRootPath:'feature/gcRootPath',compareHeaps:'feature/compareHeaps',
        exportHistogramCsv:'feature/export',copyReportText:'feature/export',exportCompareCsv:'feature/export',exportCompareMarkdown:'feature/export'};
    for(const [command,event]of Object.entries(actions)) {
        const action=session.commands.get(command);
        if(action)session.commands.set(command,m=>{session.host.telemetry?.track(event);return action(m);});
    }
    session.commands.set('tabViewed',m=>session.host.telemetry?.track('feature/tabViewed',{tab:m.tab}));
    const retry=session.commands.get('retryAnalysis');
    session.commands.set('retryAnalysis',m=>{if(['failed','cancelled'].includes(session.state))session.host.telemetry?.track('analysis/retry');return retry(m);});
    session.commands.set('telemetryOff',()=>{session.host.telemetry?.setLevel('off');session.emit('localActionStatus',{message:'Telemetry is off. Pending delivery was cleared.'});});
    session.commands.set('reviewDiagnostics',()=>session.emit('diagnosticReport',{text:JSON.stringify(session.host.telemetry?.report()||{},null,2)}));
}
module.exports={observe,install};
