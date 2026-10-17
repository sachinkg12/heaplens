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
        setInterval: () => 1, clearInterval: () => undefined,
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

test('elapsed clock starts with analysis, survives stage changes and stops on completion or Cancel', () => {
    const handlers = new Map<string, (message: any) => void>();
    const elapsed = { textContent: '' }, bar = { innerHTML: '', style: { display: '' } };
    const button = { addEventListener: () => undefined };
    let tick = () => undefined, now = 0, activeTimers = 0;
    runInNewContext(getProgressJs(), {
        onMessage: (name: string, callback: any) => handlers.set(name, callback),
        document: { getElementById: (id: string) => id === 'progress-bar' ? bar : id === 'analysis-elapsed' ? elapsed : button },
        vscode: { postMessage: () => undefined }, escapeHtml: (text: string) => text,
        Date: { now: () => now },
        setInterval: (callback: typeof tick) => { activeTimers++; tick = callback; return 1; },
        clearInterval: () => { activeTimers--; }
    });
    handlers.get('analysisStarting')?.({});
    assert.match(bar.innerHTML,/Starting analysis/);
    assert.equal(elapsed.textContent,'0s elapsed');
    now=5000; tick(); assert.equal(elapsed.textContent,'5s elapsed');
    handlers.get('analysisProgress')?.({stage:'sizing'});
    assert.equal(activeTimers,1);
    handlers.get('analysisComplete')?.({}); assert.equal(activeTimers,0);
    handlers.get('analysisStarting')?.({}); assert.equal(elapsed.textContent,'0s elapsed');
    handlers.get('analysisCancelled')?.({}); assert.equal(activeTimers,0);
});
