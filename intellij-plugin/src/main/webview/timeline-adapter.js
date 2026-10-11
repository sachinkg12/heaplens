var timelineSequence=0,timelinePending=null;
function timelineSend(message){
    if(message.command==='getTimelineData'){timelinePending='timeline-'+(++timelineSequence);message.requestId=timelinePending;}
    send(message);
}
listen('timelineError',function(m){
    if(m.requestId!==timelinePending)return;timelinePending=null;
    _buildBtn.textContent='Build Timeline';updateBuildBtn();document.getElementById('timeline-charts').textContent=m.error;
});
listen('snapshotsChanged',function(){
    timelinePending=null;_timelineSnapshots=null;_buildBtn.textContent='Build Timeline';
    document.getElementById('timeline-charts').textContent='Analyzed dumps changed. Build the timeline again.';
    send({command:'listAllAnalyzedFiles'});
});
