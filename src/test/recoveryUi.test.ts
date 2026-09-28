import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { runInNewContext } from 'vm';
import { getProgressJs } from '../webview/js/progress';

test('failed restart renders a safe Retry button; retry and completion leave no stuck error banner', () => {
    const handlers = new Map<string, (message: any) => void>();
    const posted: any[] = [];
    let click = () => undefined;
    const bar = { innerHTML: '', style: { display: '' } };
    const button = { addEventListener: (_name: string, callback: typeof click) => { click = callback; } };
    runInNewContext(getProgressJs(), {
        onMessage: (name: string, callback: any) => handlers.set(name, callback),
        document: { getElementById: (id: string) => id === 'progress-bar' ? bar : button },
        vscode: { postMessage: (message: any) => posted.push(message) },
        escapeHtml: (value: string) => value.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    });
    handlers.get('analysisFailed')?.({ message: '<img src=x onerror=alert(1)>' });
    assert.match(bar.innerHTML, /Retry/);
    assert.doesNotMatch(bar.innerHTML, /<img/);
    click(); assert.equal(posted[0].command, 'retryAnalysis');
    handlers.get('analysisRetrying')?.({});
    assert.match(bar.innerHTML, /Retrying analysis/);
    handlers.get('analysisComplete')?.({});
    assert.equal(bar.style.display, 'none');
});
