// Only native presentation tokens cross this boundary; never arbitrary CSS or HTML.
onMessage('hostAppearance', function(message) {
    if (typeof message.dark !== 'boolean' || !message.colors) return;
    var allowed = new Set(['--vscode-editor-background','--vscode-foreground','--vscode-editor-foreground',
        '--vscode-editorGroupHeader-tabsBackground','--vscode-editorWidget-background','--vscode-list-hoverBackground',
        '--vscode-panel-border','--vscode-input-background','--vscode-input-foreground','--vscode-input-border',
        '--vscode-button-background','--vscode-button-foreground','--vscode-focusBorder','--vscode-editorError-foreground',
        '--vscode-editorWarning-foreground','--hl-scrollbar-thumb']);
    Object.entries(message.colors).forEach(function(pair) {
        if (allowed.has(pair[0]) && /^#[0-9a-f]{6}$/i.test(pair[1]))
            document.documentElement.style.setProperty(pair[0], pair[1]);
    });
    document.documentElement.style.colorScheme = message.dark ? 'dark' : 'light';
});
