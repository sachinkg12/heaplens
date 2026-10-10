// Shared object renderers, with caller correlation and per-analysis lifecycle fencing.
var objectReady=false, actionSequence=0, actionPending=Object.create(null);
var actionReplies={gcRootPathResponse:'overlay',referrersResponse:'overlay',inspectObjectResponse:'inspect',
    dominatorSubtreeResponse:'flame',explainChunk:'explain',explainDone:'explain',explainError:'explain',fixAiResult:'fix',
    explainLeakChunk:'explain',explainLeakDone:'explain',explainLeakError:'explain'};
var actionCommands={gcRootPath:'overlay',getReferrers:'overlay',inspectObject:'inspect',getDominatorSubtree:'flame',
    explainObject:'explain',explainLeakSuspect:'explain',fixWithAi:'fix'};
var actionStatus=document.getElementById('local-action-status');
var actionStop=document.getElementById('local-action-stop');
var sourceNavigationPending=null;
actionStop.addEventListener('click',function(){hostSend({command:'cancelAiAssistance'});});
document.getElementById('local-action-dismiss').addEventListener('click',function(){localStatus('');});
function refreshActionStatus() {
    actionStop.disabled=!(actionPending.explain || actionPending.fix);
    actionStop.hidden=actionStop.disabled;
    document.getElementById('local-action-bar').hidden=!actionStatus.textContent && actionStop.disabled;
}
function localStatus(text,level) {
    var error=Boolean(text) && level==='error';
    actionStatus.className=error?'local-action-error':'';
    actionStatus.setAttribute('role',error?'alert':'status');
    actionStatus.setAttribute('aria-live',error?'assertive':'polite');
    actionStatus.textContent=text;refreshActionStatus();
}
function retireExplanation() {
    if(actionPending.explain) {
        delete actionPending.explain;
        hostSend({command:'cancelAiAssistance'});
        refreshActionStatus();
    }
}
var registerActionListener=onMessage;
onMessage=function(command,handler) {
    registerActionListener(command,function(message) {
        var channel=actionReplies[command];
        if(channel) {
            if(!objectReady || actionPending[channel]!==message.requestId) return;
            if(command!=='explainChunk' && command!=='explainLeakChunk') delete actionPending[channel];
            refreshActionStatus();
            if(message.error) {
                localStatus(message.error,'error');
                if(channel==='inspect') document.querySelector('#inspector-panel .inspector-loading')?.replaceChildren(document.createTextNode(message.error));
                if(channel==='flame') document.getElementById('sunburst-chart').textContent=message.error;
                return;
            }
            if(message.level==='error') localStatus(message.message || 'AI action failed.','error');
        }
        handler(message);
    });
};
function dispatchHost(message) {
    if(message.command==='copyReport') {
        if(!objectReady || !analysisData) return;
        hostSend({command:'copyReportText',text:buildIncidentReport(analysisData,analysisData.displayName || 'Heap dump')});return;
    }
    if(message.command==='goToSource') {
        if(!objectReady) return;
        var pane=document.querySelector('.tab-content.active');
        if(sourceNavigationPending){sourceFeedback(pane,message.className,'Another source lookup is in progress');return;}
        var requestId='navigate-'+(++actionSequence);
        sourceNavigationPending={requestId:requestId,className:message.className,pane:pane};
        sourceFeedback(pane,message.className,'Looking for source…');
        hostSend({command:'openProjectSource',className:message.className,requestId:requestId});return;
    }
    var channel=actionCommands[message.command];
    if(channel) {
        if(!objectReady) {localStatus('Wait for analysis or Retry before using object actions.');return;}
        if((channel==='fix' || channel==='explain') && (actionPending.fix || actionPending.explain)) {
            localStatus('An AI action is already running. Stop it or wait for completion.');
            var button=document.getElementById('inspector-explain-btn');
            if(channel==='explain' && button){button.disabled=false;button.textContent='Explain this object';}
            document.querySelectorAll('.suspect-explain-link').forEach(function(link){link.textContent='Explain';});
            return;
        }
        if(channel!=='fix' && !(message.command==='explainLeakSuspect' && message.objectId===undefined) &&
            (!Number.isSafeInteger(message.objectId) || message.objectId<(channel==='flame'?0:1))) {
            localStatus('This object ID is unsupported; no request was sent.');return;
        }
        var requestId='action-'+(++actionSequence);
        actionPending[channel]=requestId;localStatus('');
        if(channel==='fix' || channel==='explain') actionStop.disabled=false;
        // Never trust object fields, local paths or source supplied by a page.
        var request={command:message.command,requestId:requestId};
        if(message.command==='fixWithAi') request.className=message.className;
        else if(message.command==='explainLeakSuspect'){request.className=message.className;if(message.objectId!==undefined)request.objectId=message.objectId;}
        else request.objectId=message.objectId;
        if(message.command==='inspectObject') retireExplanation();
        if(message.command==='fixWithAi') localStatus('Resolving source. Nothing is sent until you approve Send Source.');
        hostSend(request);return;
    }
    if(message.command==='exportHistogramCsv' && (!objectReady || typeof message.csv!=='string')) return;
    if(message.command==='queryDependencyInfo') return; // Native source resolver owns these statuses.
    hostSend(message);
}
onMessage('localActionStatus',function(m){localStatus(m.message || '',m.level);});
onMessage('fixAiResult',function(m){localStatus(m.message || 'AI source request finished.',m.level);});
function sourceFeedback(pane,name,text) {
    if(!pane)return;
    var box=pane.querySelector('.local-source-feedback');
    if(!box){
        box=document.createElement('div');box.className='local-source-feedback';
        var label=document.createElement('span');label.setAttribute('role','status');box.appendChild(label);
        var dismiss=document.createElement('button');dismiss.className='btn';dismiss.textContent='Dismiss';
        dismiss.addEventListener('click',function(){box.hidden=true;});box.appendChild(dismiss);pane.prepend(box);
    }
    box.firstElementChild.textContent=name+': '+text;box.hidden=false;
}
function updateFixAvailability(root) {
    root.querySelectorAll('.tree-fix,.source-fix-btn,.fix-with-ai-link').forEach(function(button){
        // The native Fix handler owns fresh project lookup and verification; viewing is optional.
        button.disabled=!objectReady;button.setAttribute('aria-disabled',String(!objectReady));
        if(objectReady){button.removeAttribute('data-fix-unavailable');button.title='Find project source and ask before sending it to AI. No need to open Source first.';}
        else{button.setAttribute('data-fix-unavailable','');button.title='Wait for successful analysis or Retry before using Fix with AI.';}
    });
}
onMessage('sourceNavigationResult',function(m){
    if(!objectReady || !sourceNavigationPending || m.requestId!==sourceNavigationPending.requestId ||
        m.className!==sourceNavigationPending.className)return;
    var labels={searching:'Looking for source…',indexing:'Waiting for project indexing…',opened:'Opened project source',
        'opened-read-only':'Opened project source; file is read-only or too large for AI Fix',
        'dependency-source':'Opened attached library source (view only)',decompiled:'Opened decompiled class (view only)',
        'not-found':'No matching project or attached library source/class',cancelled:'Selection cancelled',busy:'Another source lookup is in progress',
        unavailable:'Analysis unavailable; Retry first',error:'Source lookup failed', 'too-many':'Too many matches; narrow project scope'};
    sourceFeedback(sourceNavigationPending.pane,m.className,labels[m.status] || 'Source lookup failed');
    if(m.status!=='searching' && m.status!=='indexing')sourceNavigationPending=null;
});
function resetObjectActions() {
    objectReady=false;actionPending=Object.create(null);localStatus('');
    sourceNavigationPending=null;updateFixAvailability(document);
    document.querySelectorAll('.local-source-feedback').forEach(function(box){box.hidden=true;});
    actionStop.disabled=true;
    closeInspector();closeGcPath();
    document.getElementById('report-actions').style.display='none';
    document.getElementById('sunburst-chart').textContent='';
    document.getElementById('domtree-view-flame').disabled=true;
}
onMessage('analysisProgress',function(m){if(m.stage==='loading') resetObjectActions();});
onMessage('serverCrashed',resetObjectActions);onMessage('analysisCancelled',resetObjectActions);
onMessage('analysisComplete',function(){objectReady=true;updateFixAvailability(document);document.getElementById('domtree-view-flame').disabled=false;});
document.addEventListener('click',function(e){
    if(e.target.closest('.inspector-close')) {delete actionPending.inspect;retireExplanation();}
    if(e.target.closest('.gc-path-close')) delete actionPending.overlay;
},true);
