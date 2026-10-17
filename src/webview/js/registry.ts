export function getRegistryJs(): string {
    return `
        // ---- Message handler registry ----
        // Each tab self-registers handlers via onMessage(command, fn).
        // Adding a new tab never requires editing this file.
        var _messageHandlers = {};

        function onMessage(command, fn) {
            if (!_messageHandlers[command]) _messageHandlers[command] = [];
            _messageHandlers[command].push(fn);
        }

        window.addEventListener('message', function(event) {
            var msg = event.data;

            // Lazy tab dispatch: store analysisComplete and fire for active tab
            if (msg.command === 'analysisComplete') {
                _analysisMsg = msg;
                if (!_tabRendered[_activeTab] && _tabAnalysisHandlers[_activeTab]) {
                    _tabRendered[_activeTab] = true;
                    var lazyHandlers = _tabAnalysisHandlers[_activeTab];
                    for (var j = 0; j < lazyHandlers.length; j++) { lazyHandlers[j](msg); }
                }
            }

            var handlers = _messageHandlers[msg.command];
            if (handlers) {
                for (var i = 0; i < handlers.length; i++) {
                    handlers[i](msg);
                }
            }
        });

        // ---- Lazy tab-specific analysisComplete registry ----
        // Tabs that are not visible on load register via onTabMessage('tabName', 'analysisComplete', fn).
        // Their handler fires only when the tab is first activated, with the stored analysisMsg.
        // For any other command, falls through to onMessage (always fires).
        var _activeTab = 'overview';
        var _analysisMsg = null;
        var _tabAnalysisHandlers = {};
        var _tabRendered = {};

        function onTabMessage(tabName, command, fn) {
            if (command !== 'analysisComplete') {
                onMessage(command, fn);
                return;
            }
            if (!_tabAnalysisHandlers[tabName]) _tabAnalysisHandlers[tabName] = [];
            _tabAnalysisHandlers[tabName].push(fn);

            // Tab is already active and data arrived: fire now
            if (tabName === _activeTab && _analysisMsg && !_tabRendered[tabName]) {
                _tabRendered[tabName] = true;
                fn(_analysisMsg);
            }
        }

        // ---- Tab activation hooks ----
        // Tabs call onTabActivate(tabName, fn) to run code when their tab is shown.
        var _tabActivateHandlers = {};

        function onTabActivate(tabName, fn) {
            if (!_tabActivateHandlers[tabName]) _tabActivateHandlers[tabName] = [];
            _tabActivateHandlers[tabName].push(fn);
        }

        // ---- Tab switching ----
        document.querySelectorAll('.tab-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.tab-btn').forEach(function(b) {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                    b.setAttribute('tabindex', '-1');
                });
                document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                btn.setAttribute('tabindex', '0');
                document.getElementById('tab-' + btn.dataset.tab).classList.add('active');

                _activeTab = btn.dataset.tab;

                // Track tab view for telemetry
                vscode.postMessage({ command: 'tabViewed', tab: btn.dataset.tab });

                // Lazy init: fire analysisComplete for this tab if not yet rendered
                if (_analysisMsg && !_tabRendered[_activeTab] && _tabAnalysisHandlers[_activeTab]) {
                    _tabRendered[_activeTab] = true;
                    var handlers = _tabAnalysisHandlers[_activeTab];
                    for (var i = 0; i < handlers.length; i++) { handlers[i](_analysisMsg); }
                }

                var hooks = _tabActivateHandlers[btn.dataset.tab];
                if (hooks) {
                    for (var i = 0; i < hooks.length; i++) {
                        hooks[i]();
                    }
                }
            });
        });

        // ---- Keyboard navigation for tab bar ----
        var _tabBar = document.querySelector('.tab-bar');
        if (_tabBar) {
            _tabBar.addEventListener('keydown', function(e) {
                var tabs = Array.from(document.querySelectorAll('.tab-btn')).filter(function(b){return !b.disabled;});
                var idx = tabs.indexOf(document.activeElement);
                if (idx === -1) return;
                var target = null;
                if (e.key === 'ArrowRight') {
                    target = tabs[(idx + 1) % tabs.length];
                } else if (e.key === 'ArrowLeft') {
                    target = tabs[(idx - 1 + tabs.length) % tabs.length];
                } else if (e.key === 'Home') {
                    target = tabs[0];
                } else if (e.key === 'End') {
                    target = tabs[tabs.length - 1];
                }
                if (target) {
                    e.preventDefault();
                    target.focus();
                    target.click();
                }
            });
        }
    `;
}
