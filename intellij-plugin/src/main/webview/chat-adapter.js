// Private AI channel: history is host-owned; queries run only after an explicit button click.
var aiReady=false, aiSequence=0, aiPending=null, aiConfiguring=false;
var aiStatus=document.getElementById('ai-status');
var aiConfigure=document.getElementById('ai-configure');
var aiStop=document.getElementById('ai-stop');
_chatInput.setAttribute('maxlength','4000');
var chatQueryId=null;
var chatQueryContext=null;

function aiControls() {
    _chatSend.disabled=!aiReady || !!aiPending || aiConfiguring;
    _chatInput.disabled=!aiReady || aiConfiguring;
    aiConfigure.disabled=!!aiPending || aiConfiguring;
    aiStop.disabled=!aiPending;
}
function acceptsAi(message) {return aiReady && aiPending && message.requestId===aiPending;}
function finishAi() {aiPending=null;_isChatStreaming=false;aiControls();}
function requestAi(message) {
    if(message.command==='executeQuery') {
        if(!aiReady || chatQueryId || typeof message.query!=='string' || message.query.length>32000) {
            if(_pendingChatQuery) {_pendingChatQuery.button.disabled=false;_pendingChatQuery.button.textContent='Run Query';_pendingChatQuery=chatQueryContext;}
            aiStatus.textContent='Wait for analysis and the previous inline query; queries are limited to 32,000 characters.';return;
        }
        chatQueryId='chat-query-'+(++aiSequence);
        chatQueryContext=_pendingChatQuery;
        _chatMessages.querySelectorAll('.chat-run-query-btn').forEach(function(button){button.disabled=true;});
        send({command:'aiRunQuery',requestId:chatQueryId,query:message.query});return;
    }
    if(message.command==='clearChatHistory') {
        clearAiUi('Chat cleared. Earlier requests cannot be recalled from a provider.');
        send({command:'aiClear'});return;
    }
    if(message.command!=='chatMessage') return;
    if(!aiReady || aiPending || aiConfiguring || typeof message.text!=='string' || !message.text.trim() || message.text.length>4000) {
        _isChatStreaming=false;_currentBubble=null;_chatStreamBuffer='';
        aiStatus.textContent='Wait for analysis/configuration, then enter up to 4,000 characters.';aiControls();return;
    }
    aiPending='ai-'+(++aiSequence);aiStatus.textContent='Preparing AI request. Session approval will be requested if needed.';
    aiControls();send({command:'aiSend',requestId:aiPending,text:message.text});
}
function clearAiUi(note) {
    chatQueryId=null;chatQueryContext=null;
    aiPending=null;_isChatStreaming=false;_currentBubble=null;_chatStreamBuffer='';_pendingChatQuery=null;
    _chatMessages.innerHTML='';
    if(_chatPlaceholder) {_chatPlaceholder.style.display='block';_chatMessages.appendChild(_chatPlaceholder);}
    aiStatus.textContent=note;aiControls();
}
aiConfigure.addEventListener('click',function() {
    if(aiConfiguring || aiPending) return;
    aiConfiguring=true;aiControls();send({command:'aiConfigure'});
});
aiStop.addEventListener('click',function() {if(aiPending) send({command:'aiStop'});});
listen('aiConfiguration',function(message) {
    aiConfiguring=false;aiStatus.textContent=message.message || 'Configuration closed.';aiControls();
});
listen('aiReset',function(message) {clearAiUi(message.message || 'Chat cleared.');});
listen('aiQueryResult',function(message){
    if(!aiReady || message.requestId!==chatQueryId || !_pendingChatQuery)return;
    renderChatQueryResult(_pendingChatQuery.codeBlock,_pendingChatQuery.button,message.result);
    var link=_pendingChatQuery.codeBlock.parentElement.querySelector('.chat-query-link');
    if(link)link.addEventListener('click',function(){
        document.getElementById('query-input').value=message.query;
        document.getElementById('query-input').dispatchEvent(new Event('input'));
        document.getElementById('query-run-btn').click();
    });
    chatQueryId=null;chatQueryContext=null;_pendingChatQuery=null;
    _chatMessages.querySelectorAll('.chat-run-query-btn').forEach(function(button){button.disabled=false;});
});
listen('aiQueryError',function(message){
    if(message.requestId!==chatQueryId)return;
    if(_pendingChatQuery){_pendingChatQuery.button.disabled=false;_pendingChatQuery.button.textContent='Run Query';}
    chatQueryId=null;chatQueryContext=null;_pendingChatQuery=null;aiStatus.textContent=message.error || 'Query failed.';
    _chatMessages.querySelectorAll('.chat-run-query-btn').forEach(function(button){button.disabled=false;});
});
listen('aiHistoryStatus',function(message){aiStatus.textContent=message.message;});
listen('analysisComplete',function() {aiReady=true;aiControls();});
listen('analysisProgress',function(message) {
    if(message.stage==='loading') {aiReady=false;clearAiUi('Waiting for heap analysis. Conversation reset.');}
});
listen('serverCrashed',function() {aiReady=false;clearAiUi('Analysis unavailable. Retry before chatting.');});
listen('analysisCancelled',function() {aiReady=false;clearAiUi('Analysis cancelled. Retry before chatting.');});
aiControls();
