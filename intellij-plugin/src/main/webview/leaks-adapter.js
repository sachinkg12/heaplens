// Shared cards and filters; explanation replies use exact datasets, not CSS selectors
// constructed from heap class names. The global action bridge fences request IDs.
var leakAnswer='';
var sharedLeakRender=renderLeakSuspects;
renderLeakSuspects=function(rows){sharedLeakRender(rows);updateFixAvailability(document.getElementById('tab-leaks'));};
function leakReply(message,done,error) {
    var object=String(message.objectId || '');
    var link=Array.from(document.querySelectorAll('.suspect-explain-link')).find(function(item){
        return item.dataset.class===message.className && (item.dataset.objectId || '')===object;
    });
    if(!link)return;
    var area=document.getElementById(link.dataset.target);if(!area)return;
    if(message.text)leakAnswer+=message.text;
    area.classList.add('visible');
    if(error){area.textContent=message.message || 'AI request failed.';area.classList.add('error');}
    else area.innerHTML=renderMarkdown(leakAnswer);
    if(done || error){area.classList.remove('streaming');link.textContent='Explain';addExplainCloseBtn(area);leakAnswer='';}
}
listen('explainLeakChunk',function(m){leakReply(m,false,false);});
listen('explainLeakDone',function(m){leakReply(m,true,false);});
listen('explainLeakError',function(m){leakReply(m,false,true);});
document.getElementById('tab-leaks').addEventListener('click',function(e){if(e.target.closest('.suspect-explain-link'))leakAnswer='';},true);
function resetLeaks(){leakAnswer='';_explainLeakBuffers={};renderLeakSuspects([]);renderObjectLeakSuspects([]);}
listen('analysisProgress',function(m){if(m.stage==='loading')resetLeaks();});
listen('analysisCancelled',resetLeaks);listen('serverCrashed',resetLeaks);
