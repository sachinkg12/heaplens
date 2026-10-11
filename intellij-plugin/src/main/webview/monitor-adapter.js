function monitorSend(message){
    if(message.command==='startMonitor'){
        _monDisconnectBtn.disabled=false;
        document.getElementById('monitor-histogram-table').textContent='';
        document.getElementById('monitor-line-chart').textContent='';
    }
    send(message);
}
listen('monitorError',function(){
    _monConnectBtn.disabled=_monitorConnected;_monDisconnectBtn.disabled=!_monitorConnected;
    _monHistBtn.textContent='Snapshot Histogram';_monHistBtn.disabled=!_monitorConnected;
});
listen('monitorDisconnected',function(){_monHistBtn.textContent='Snapshot Histogram';});
