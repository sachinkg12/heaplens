import { chatQuerySegments } from './chatQueries';

export function getChatJs(): string {
    return `
        // ---- Tab 9: AI Chat ----
        // Self-contained: owns streaming state, bubble creation, DOM refs.

        var _chatMessages = document.getElementById('chat-messages');
        var _chatInput = document.getElementById('chat-input');
        var _chatSend = document.getElementById('chat-send');
        var _chatPlaceholder = document.getElementById('chat-placeholder');
        var _currentBubble = null;
        var _isChatStreaming = false;
        var _chatStreamBuffer = '';
        var _pendingChatQuery = null; // { bubble, codeBlock } when waiting for query result
        var _chatQuerySequence = 0;
        var _chatQueryEpoch = 0;
        var _chatQueryReady = false;
        var chatQuerySegments = ${chatQuerySegments.toString()};

        function addChatBubble(role, text) {
            if (_chatPlaceholder) _chatPlaceholder.style.display = 'none';
            var bubble = document.createElement('div');
            bubble.className = 'chat-bubble ' + role;
            bubble.textContent = text;
            _chatMessages.appendChild(bubble);
            _chatMessages.scrollTop = _chatMessages.scrollHeight;
            return bubble;
        }

        function sendChatMessage() {
            var text = _chatInput.value.trim();
            if (!text || _isChatStreaming) return;
            addChatBubble('user', text);
            _chatInput.value = '';
            _chatInput.style.height = 'auto';
            _currentBubble = addChatBubble('assistant', '');
            _chatStreamBuffer = '';
            _isChatStreaming = true;
            _chatSend.disabled = true;
            vscode.postMessage({ command: 'chatMessage', text: text });
        }

        _chatSend.addEventListener('click', sendChatMessage);
        _chatInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
        });
        _chatInput.addEventListener('input', function() {
            _chatInput.style.height = 'auto';
            _chatInput.style.height = Math.min(_chatInput.scrollHeight, 120) + 'px';
        });

        // ---- Self-register ----
        onMessage('chatChunk', function(msg) {
            if (_currentBubble) {
                _chatStreamBuffer += msg.text;
                _currentBubble.textContent = _chatStreamBuffer;
                _chatMessages.scrollTop = _chatMessages.scrollHeight;
            }
        });

        function updateChatQueryButtons() {
            _chatMessages.querySelectorAll('.chat-run-query-btn').forEach(function(button) {
                button.disabled = !_chatQueryReady || !!_pendingChatQuery || button.dataset.expired === 'true';
            });
        }
        function renderChatAnswer(bubble, text) {
            bubble.textContent = '';
            chatQuerySegments(text).forEach(function(segment) {
                if (!segment.query) { var prose=document.createElement('div');prose.innerHTML=renderMarkdown(segment.text);bubble.appendChild(prose);return; }
                var query=segment.query;
                var pre=document.createElement('pre');pre.className='md-code-block';
                var code=document.createElement('code');code.className='language-heapql';code.textContent=query;pre.appendChild(code);bubble.appendChild(pre);
                var btn = document.createElement('button');
                btn.className = 'chat-run-query-btn';
                btn.textContent = 'Run Query';
                var epoch=_chatQueryEpoch;
                btn.addEventListener('click', function() {
                    if (!_chatQueryReady || epoch!==_chatQueryEpoch || _pendingChatQuery || !bubble.isConnected) return;
                    btn.disabled = true;
                    btn.textContent = 'Running...';
                    var requestId='chat-query-'+(++_chatQuerySequence);
                    _pendingChatQuery = { bubble: bubble, codeBlock: pre, button: btn, query:query, requestId:requestId };
                    updateChatQueryButtons();
                    vscode.postMessage({ command: 'executeQuery', query: query, requestId:requestId });
                });
                bubble.appendChild(btn);
            });
            bubble.classList.add('rendered');
            updateChatQueryButtons();
        }

        function retireChatQueries() {
            _chatQueryReady=false;_chatQueryEpoch++;_pendingChatQuery=null;
            _chatMessages.querySelectorAll('.chat-run-query-btn').forEach(function(button){button.dataset.expired='true';button.disabled=true;});
        }
        ['analysisStarting','analysisRetrying','serverCrashed','analysisCancelled'].forEach(function(command){onMessage(command,retireChatQueries);});
        onMessage('analysisProgress',function(msg){if(msg.stage==='loading')retireChatQueries();});
        onMessage('analysisComplete',function(){_chatQueryReady=true;updateChatQueryButtons();});

        function renderChatQueryResult(pre, btn, result, query) {
            // Remove any existing result for this block
            var existing = btn.nextElementSibling;
            if (existing && existing.classList.contains('chat-query-result')) existing.remove();

            var container = document.createElement('div');
            container.className = 'chat-query-result';

            if (!result || !result.rows || result.rows.length === 0) {
                container.innerHTML = '<div style="opacity:0.5;padding:8px;">No results</div>';
                btn.insertAdjacentElement('afterend', container);
                btn.textContent = 'Run Query';
                btn.disabled = false;
                return;
            }

            var cols = result.columns || [];
            var rows = result.rows || [];
            var maxRows = Math.min(rows.length, 50);

            var html = '<table><thead><tr>';
            cols.forEach(function(c) { html += '<th>' + escapeHtml(c) + '</th>'; });
            html += '</tr></thead><tbody>';

            for (var i = 0; i < maxRows; i++) {
                html += '<tr>';
                cols.forEach(function(c, ci) {
                    var val = rows[i][ci];
                    if (c === 'shallow_size' || c === 'retained_size') {
                        html += '<td class="right">' + fmt(val) + '</td>';
                    } else {
                        html += '<td>' + escapeHtml(String(val != null ? val : '')) + '</td>';
                    }
                });
                html += '</tr>';
            }
            html += '</tbody></table>';

            if (rows.length > maxRows) {
                html += '<div class="chat-query-more">Showing ' + maxRows + ' of ' + rows.length + ' rows. <span class="chat-query-link">See full results in Query tab</span></div>';
            }

            var timeMs = result.execution_time_ms !== undefined ? result.execution_time_ms : '?';
            html += '<div class="chat-query-status">' + rows.length + ' rows (' + escapeHtml(String(timeMs)) + 'ms)</div>';

            container.innerHTML = html;
            btn.insertAdjacentElement('afterend', container);
            btn.textContent = 'Run Query';
            btn.disabled = false;

            // "See full results" link switches to query tab
            var link = container.querySelector('.chat-query-link');
            if (link) {
                link.addEventListener('click', function() {
                    var queryTab = document.querySelector('.tab-btn[data-tab="query"]');
                    if (queryTab) queryTab.click();
                    if (typeof query==='string') {
                        var input=document.getElementById('query-input');var run=document.getElementById('query-run-btn');
                        if(input && run){input.value=query;input.dispatchEvent(new Event('input'));run.click();}
                    }
                });
            }

            _chatMessages.scrollTop = _chatMessages.scrollHeight;
        }

        function attachInvestigationEvidence(area, evidence) {
            var answerText = area.textContent || '';
            var seen = new Set();
            var cited = (Array.isArray(evidence) ? evidence : []).slice(0, 32).filter(function(record) {
                if (!record || typeof record.id !== 'string' || !/^E[a-f0-9]{12}_[1-9][0-9]{0,3}$/.test(record.id)
                    || answerText.indexOf('[' + record.id + ']') < 0 || seen.has(record.id)) return false;
                seen.add(record.id); return true;
            });
            if (cited.length) {
                var note = document.createElement('small');
                note.style.display = 'block'; note.style.marginTop = '8px';
                note.textContent = 'AI interpretation may be wrong. Evidence below is engine metadata, not proof of a cause or repair.';
                area.appendChild(note);
            }
            cited.forEach(function(record) {
                var button = document.createElement('button');
                button.className = 'chat-clear';
                button.textContent = 'View evidence: ' + record.operation;
                button.addEventListener('click', function() { vscode.postMessage({command:'openAiEvidence', id:record.id}); });
                area.appendChild(button);
            });
        }
        // Native/browser hosts scope chat in an IIFE; object views share only this safe renderer.
        window.attachInvestigationEvidence = attachInvestigationEvidence;
        function retireInvestigationViewer() {
            var viewer=document.getElementById('heaplens-ai-evidence');
            if(viewer){if(viewer.open)viewer.close();viewer.remove();}
        }
        ['analysisStarting','analysisRetrying','serverCrashed','analysisCancelled','aiReset'].forEach(function(command){onMessage(command,retireInvestigationViewer);});
        onMessage('analysisProgress',function(msg){if(msg.stage==='loading')retireInvestigationViewer();});

        onMessage('aiEvidenceResult', function(msg) {
            var viewer = document.getElementById('heaplens-ai-evidence');
            if (!viewer) { viewer = document.createElement('dialog'); viewer.id = 'heaplens-ai-evidence'; document.body.appendChild(viewer); }
            viewer.textContent = '';
            var close = document.createElement('button'); close.textContent = 'Close evidence'; close.addEventListener('click',function(){viewer.close();});viewer.appendChild(close);
            var content = document.createElement('pre'); content.style.whiteSpace = 'pre-wrap';
            content.textContent = msg.error || (msg.record ? 'Evidence ' + msg.record.id + ' — ' + msg.record.operation + '\\n' + JSON.stringify(msg.record.data, null, 2) : 'Evidence unavailable.');
            viewer.appendChild(content);if (!viewer.open) viewer.showModal();
        });

        onMessage('aiInvestigationProgress', function(msg) {
            var areas = [];
            if (msg.channel === 'chat' && _currentBubble) areas.push(_currentBubble);
            if (msg.channel === 'explain') { var inspector = document.getElementById('inspector-explain-area'); var panel = document.getElementById('inspector-panel'); if (inspector && panel && panel.dataset.objectId === String(msg.objectId)) areas.push(inspector); }
            if (msg.channel === 'explainLeak' && typeof msg.className === 'string') {
                var target = msg.objectId ? 'explain-obj-' + leakEvidenceKey(msg.className,msg.objectId) : 'explain-' + leakEvidenceKey(msg.className);
                var targetArea = document.getElementById(target); if(targetArea)areas.push(targetArea);
            }
            areas.forEach(function(area) {
                area.textContent = msg.message || 'Investigating…';
                if (msg.channel !== 'chat') {
                    var stop = document.createElement('button'); stop.textContent = 'Stop investigation';
                    stop.addEventListener('click', function() { vscode.postMessage({command:'stopAi',channel:msg.channel}); }); area.appendChild(stop);
                }
            });
        });

        var _chatStop = document.getElementById('chat-stop');
        if (_chatStop) _chatStop.addEventListener('click', function() { vscode.postMessage({command:'stopAi'}); });

        onMessage('chatDone', function(msg) {
            if (_currentBubble && _chatStreamBuffer) {
                if (msg.safeEvidenceAnswer) {
                    renderChatAnswer(_currentBubble, _chatStreamBuffer);
                    attachInvestigationEvidence(_currentBubble, msg.evidence);
                } else {
                    renderChatAnswer(_currentBubble, _chatStreamBuffer);
                }
            }
            _isChatStreaming = false;
            _chatSend.disabled = false;
            _currentBubble = null;
            _chatStreamBuffer = '';
        });

        onMessage('chatError', function(msg) {
            if (_currentBubble && _chatStreamBuffer) {
                _currentBubble.textContent = 'Incomplete AI answer — not a completed diagnosis.\\n\\n' + _chatStreamBuffer;
                _currentBubble.classList.add('error');
            }
            _isChatStreaming = false;
            _chatSend.disabled = false;
            _currentBubble = null;
            _chatStreamBuffer = '';
            addChatBubble('error', msg.message || 'An error occurred');
        });

        onMessage('chatQueryResult', function(msg) {
            if (_pendingChatQuery && msg.requestId===_pendingChatQuery.requestId) {
                renderChatQueryResult(_pendingChatQuery.codeBlock, _pendingChatQuery.button, msg.result, _pendingChatQuery.query);
                _pendingChatQuery = null;
                updateChatQueryButtons();
                return true;
            }
            return false;
        });

        onMessage('chatQueryError', function(msg) {
            if (!_pendingChatQuery || msg.requestId!==_pendingChatQuery.requestId) return false;
            var pending=_pendingChatQuery;_pendingChatQuery=null;
            pending.button.textContent='Run Query';
            var previous=pending.button.nextElementSibling;if(previous && previous.classList.contains('chat-query-result'))previous.remove();
            var error=document.createElement('div');error.className='chat-query-result error';error.textContent=msg.error || 'Query failed. Check its syntax and retry.';
            pending.button.insertAdjacentElement('afterend',error);updateChatQueryButtons();return true;
        });

        onMessage('restoreChatHistory', function(msg) {
            var messages = msg.messages || [];
            if (messages.length === 0) return;
            if (_chatPlaceholder) _chatPlaceholder.style.display = 'none';
            addChatBubble('system', 'Previous local conversation. Its evidence links have expired and are not reused by this analysis.');
            messages.forEach(function(m) {
                if (m.role === 'user') {
                    addChatBubble('user', m.content);
                } else if (m.role === 'assistant') {
                    var bubble = addChatBubble('assistant', '');
                    bubble.textContent = m.content;
                    bubble.style.whiteSpace = 'pre-wrap';
                }
            });
        });

        var _chatClear = document.getElementById('chat-clear');
        if (_chatClear) {
            _chatClear.addEventListener('click', function() {
                _isChatStreaming = false;
                _chatSend.disabled = false;
                _currentBubble = null;
                _chatStreamBuffer = '';
                _pendingChatQuery = null;
                _chatMessages.innerHTML = '';
                if (_chatPlaceholder) {
                    _chatPlaceholder.style.display = 'block';
                    _chatMessages.appendChild(_chatPlaceholder);
                }
                vscode.postMessage({ command: 'clearChatHistory' });
            });
        }
    `;
}
