/** A shared readiness view; shallow data never enters full-analysis tab handlers. */
export function getProgressiveJs(): string {
    return `
        (function() {
            var shallow = null, busy = false, scope = 'full', page = 0;
            var scan = document.getElementById('quick-scan-btn');
            var retained = document.getElementById('analyze-retained-btn');
            var status = document.getElementById('analysis-mode-status');
            var panel = document.getElementById('shallow-histogram');
            var search = document.getElementById('histogram-search');
            function controls() { scan.disabled = busy; retained.disabled = busy || scope === 'full'; search.disabled = (busy || scope==='shallow') && !shallow; }
            function gate() {
                document.querySelectorAll('.tab-btn').forEach(function(b) {
                    b.disabled = (scope === 'shallow' || busy) && !['overview','histogram'].includes(b.dataset.tab);
                    if (b.disabled) b.title = busy ? 'Waiting for retained analysis to complete.' : 'Choose Analyze Retained to calculate this view.';
                    else b.removeAttribute('title');
                });
                if ((scope === 'shallow' || busy) && !['overview','histogram'].includes(_activeTab)) document.getElementById('tabBtn-overview').click();
                document.body.classList.toggle('shallow-analysis', scope === 'shallow' || !!shallow || busy);
                controls();
            }
            function reset() {
                analysisData = null; _analysisMsg = null; _tabRendered = {}; shallow = null; page = 0;
                ['top-objects-table','diagnosis-section','pie-chart','bar-chart','histogram-table','histogram-instances-panel'].forEach(function(id) {
                    document.getElementById(id).textContent = '';
                });
                var overlay = document.getElementById('gc-path-overlay'); if(overlay) overlay.style.display = 'none';
                // Inspector visibility belongs to its CSS class, not an inline hide.
                var inspector = document.getElementById('inspector-panel');
                if(inspector) { inspector.classList.remove('visible'); inspector.style.display = ''; inspector.textContent = ''; }
                document.getElementById('report-actions').style.display = 'none';
                document.getElementById('stats-bar').textContent = 'Waiting for analysis…';
                panel.textContent = '';
            }
            function begin(next) {
                busy = true; scope = next; reset(); gate();
                status.textContent = next === 'shallow' ? 'Quick Scan: retained memory, references and Waste are not calculated.' : 'Full retained analysis running…';
            }
            scan.addEventListener('click', function() { if(busy)return; begin('shallow'); vscode.postMessage({command:'quickScan'}); });
            retained.addEventListener('click', function() { if(busy)return; begin('full'); vscode.postMessage({command:'analyzeRetained'}); });
            function rows() { var term = search.value.toLowerCase(); return shallow.classHistogram.filter(function(c) {return c.class_name.toLowerCase().includes(term);}); }
            function csvCell(value) {
                var s = String(value);
                if (/^[\\s\\u0000-\\u001f]*[=+@-]/.test(s)) s = "'" + s;
                return '"' + s.replace(/"/g,'""') + '"';
            }
            function render() {
                if(!shallow)return;
                var filtered = rows(); page = Math.min(page, Math.max(0,Math.ceil(filtered.length/200)-1));
                panel.innerHTML = '<p class="scan-note">Shallow allocation histogram. Retained sizes and percentages are not calculated. '+(scope==='shallow' ? 'No instance index was built.' : 'Graph analysis continues in the background.')+'</p>' +
                    '<div><button class="btn" id="scan-export">Export shallow CSV</button> <button class="btn" id="scan-prev">Previous</button> <button class="btn" id="scan-next">Next</button> <span>'+fmtNum(filtered.length)+' classes · page '+(page+1)+'/'+Math.max(1,Math.ceil(filtered.length/200))+'</span></div>' +
                    '<table><thead><tr><th>Class</th><th class="right">Allocations</th><th class="right">Shallow</th><th>Retained</th></tr></thead><tbody>' +
                    filtered.slice(page*200,(page+1)*200).map(function(c) {
                        return '<tr><td>'+escapeHtml(c.class_name)+'</td><td class="right">'+fmtNum(c.instance_count)+'</td><td class="right">'+fmt(c.shallow_size)+'</td><td>Not calculated</td></tr>';
                    }).join('')+'</tbody></table>';
                var prev = document.getElementById('scan-prev'), next = document.getElementById('scan-next');
                prev.disabled = page === 0; next.disabled = (page+1)*200 >= filtered.length;
                prev.addEventListener('click',function(){page--;render();}); next.addEventListener('click',function(){page++;render();});
                document.getElementById('scan-export').addEventListener('click',function(){
                    var csv = 'analysis_scope,class_name,allocation_count,shallow_bytes,retained_status\\n'+filtered.map(function(c){
                        return ['shallow',c.class_name,c.instance_count,c.shallow_size,'not_calculated'].map(csvCell).join(',');
                    }).join('\\n');
                    if(csv.length > 8*1024*1024){status.textContent='Export exceeds 8 MiB; narrow the filter.';return;}
                    vscode.postMessage({command:'exportHistogramCsv',csv:csv});
                });
            }
            search.addEventListener('input',function(){page=0;render();});
            onMessage('analysisStarting',function(m){begin(m.analysisScope === 'shallow' ? 'shallow' : 'full');});
            function stats(cells) {
                document.getElementById('stats-bar').innerHTML=cells.map(function(c){return '<div class="stat-card"><div class="label">'+escapeHtml(c[0])+'</div><div class="value">'+escapeHtml(c[1])+'</div></div>';}).join('');
            }
            onMessage('analysisProgress',function(m){
                busy=true; if(m.stage==='quick_scan')scope='shallow';
                var p=m.snapshot;
                if(p && p.kind==='records' && !shallow) {
                    stats([['Instance records so far',fmtNum(p.instances)],['Array records so far',fmtNum(p.arrays)],['Class records so far',fmtNum(p.classes)],['GC-root records so far',fmtNum(p.roots)]]);
                    status.textContent='Reading heap records · counts are partial. Heap sizes and reachability are not calculated yet.';
                }
                if(p && p.kind==='shallow') {
                    shallow={summary:p.summary,classHistogram:p.class_histogram};page=0;
                    var s=p.summary;
                    stats([['Reachable heap','Not calculated'],['Total heap (estimate)',fmt(s.total_heap_size)],['Objects',fmtNum(s.total_instances)],['Classes',fmtNum(s.total_classes)],['Arrays',fmtNum(s.total_arrays)],['GC roots',fmtNum(s.total_gc_roots)]]);
                    status.textContent='Overview and shallow histogram ready · graph and retained analysis continue. No second analysis is started.';
                    render();
                } else if(shallow) {
                    var labels={edges:'Building references',dominators:'Calculating retained sizes',index_publishing:'Validating and publishing the index'};
                    if(labels[m.stage])status.textContent='Overview and shallow histogram ready · '+labels[m.stage]+'…';
                }
                gate();
            });
            onMessage('shallowScanComplete',function(m){
                reset(); shallow=m; scope='shallow';busy=false;gate();
                var s=m.summary;
                document.getElementById('stats-bar').innerHTML=[
                    ['Reachable heap','Not calculated'],['Shallow allocation total',fmt(s.total_heap_size)],
                    ['Instance records',fmtNum(s.total_instances)],['Declared classes',fmtNum(s.declared_classes)],
                    ['Array records',fmtNum(s.total_arrays)],['GC-root records',fmtNum(s.total_gc_roots)]
                ].map(function(c){return '<div class="stat-card"><div class="label">'+c[0]+'</div><div class="value">'+c[1]+'</div></div>';}).join('');
                status.textContent='Quick Scan complete · JVM layout estimates. Retained sizes, references, queries, AI and Waste are not calculated. Analyze Retained runs a fresh full analysis; it is not a low-memory guarantee.';
                document.getElementById('progress-bar').style.display='none'; render();
            });
            onMessage('analysisComplete',function(m){
                scope='full';busy=false;shallow=null;gate();panel.textContent='';status.textContent='Full analysis ready.';
                var storage=m.storage;
                if(storage && storage.mode==='memory' && storage.cache_status==='disabled')status.textContent+=' References: memory.';
                else if(storage && storage.mode==='disk' && ['built','reused'].includes(storage.cache_status))status.textContent+=' References: disk · Index '+storage.cache_status+'.';
            });
            ['analysisCancelled','analysisFailed','serverCrashed'].forEach(function(command){onMessage(command,function(){busy=false;scope='shallow';gate();status.textContent=(shallow?'Shallow results only · retained analysis did not complete. ':'')+'Analysis unavailable. Retry repeats the selected mode, or choose Quick Scan.';});});
            onMessage('analysisModeStatus',function(m){status.textContent=m.message;});
            controls();
        })();
    `;
}
