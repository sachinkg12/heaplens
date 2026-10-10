// Host adapter contracts. Native layout and shared renderer behavior have separate browser tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/main/webview/dominator-adapter.js', 'utf8');
function node(id = 42) {
  return { object_id: id, node_type: 'Instance', class_name: 'example.Owner', shallow_size: 24, retained_size: 128 };
}
function harness() {
  const handlers = {}, sent = [], rows = [];
  function element() {
    return { textContent: '', style: {}, attributes: {}, disabled: false,
      setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; },
      remove() { this.removed = true; }, classList: { contains: () => false } };
  }
  const elements = Object.fromEntries(['dominator-status', 'reset-tree-btn', 'domtree-header'].map(id => [id, element()]));
  const tree = element();
  tree.querySelectorAll = selector => rows.filter(row => selector.includes('"' + row.id + '"'));
  const c = { document: { getElementById: id => elements[id] }, _domTreeContainer: tree,
    _tabRendered: {}, _treeData: [], send: msg => sent.push(msg),
    listen: (name, fn) => { handlers[name] = fn; },
    createTreeRow: obj => {
      const row = element(); row.id = obj.object_id;
      const parts = Object.fromEntries(['.tree-actions', '.tree-toggle', '.tree-pct', '.tree-bar'].map(s => [s, element()]));
      row.querySelector = selector => parts[selector];
      parts['.tree-pct'].textContent = ((obj.retained_size / c._totalRetained) * 100).toFixed(1) + '%';
      rows.push(row); return row;
    },
    renderDominatorTree: layers => {
      rows.length = 0; c._treeData = layers;
      c._totalRetained = layers.reduce((sum, n) => sum + n.retained_size, 0);
      layers.forEach(n => c.createTreeRow(n, 0));
    }
  };
  vm.runInNewContext(source, c);
  const h = { c, handlers, sent, rows, elements, tree };
  h.ready = () => { handlers.analysisComplete({}); c.dominatorHeap = 512; c.renderDominatorTree([node()]); };
  h.request = id => { c.requestDominatorChildren({ command: 'getChildren', objectId: id }); return sent.at(-1); };
  return h;
}
test('tree transport is allowlisted, deduplicated and correlated per object', () => {
  const h = harness(); h.ready();
  const a = h.request(42); h.request(42);
  assert.equal(h.sent.length, 1); assert.equal(a.command, 'dominatorChildren');
  h.c.requestDominatorChildren({ command: 'fixWithAi', objectId: 42 });
  h.c.requestDominatorChildren({ command: 'getChildren', objectId: 1.5 });
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent.at(-1).command, 'fixWithAi');
  assert.equal(h.c.acceptDominatorReply({ ...a, requestId: 'unrelated', children: [] }), false);
  assert.equal(h.c.acceptDominatorReply({ ...a, children: [] }), true);
  assert.equal(h.c.acceptDominatorReply({ ...a, children: [] }), false);
});
test('tree percentages use reachable heap, and shared object actions remain present', () => {
  const h = harness(); h.ready();
  assert.equal(h.rows[0].querySelector('.tree-pct').textContent, '25.0%');
  assert.equal(h.rows[0].querySelector('.tree-actions').removed, undefined);
  assert.equal(h.rows[0].attributes.tabindex, '0');
  for (const value of [undefined, 0, -1, '512', NaN, Infinity]) {
    h.c.dominatorHeap = value; h.c.renderDominatorTree([node()]);
    assert.equal(h.rows[0].querySelector('.tree-pct').textContent, 'N/A');
  }
});
test('Back to Root retires pending replies even when the same node is expanded again', () => {
  const h = harness(); h.ready(); const old = h.request(42);
  h.c.renderDominatorTree([node()]); const fresh = h.request(42);
  assert.notEqual(old.requestId, fresh.requestId);
  assert.equal(h.c.acceptDominatorReply({ ...old, children: [node(43)] }), false);
  assert.equal(h.c.acceptDominatorReply({ ...fresh, children: [node(43)] }), true);
});
test('malformed child data leaves a retryable row, never a false leaf', () => {
  for (const children of [null, {}, [null], [node()], [{ ...node(43), node_type: '<img>' }],
    [{ ...node(43), object_id: 9007199254740992 }]]) {
    const h = harness(); h.ready(); const request = h.request(42);
    assert.equal(h.c.acceptDominatorReply({ ...request, children }), false);
    assert.match(h.elements['dominator-status'].textContent, /Invalid/);
    assert.equal(h.rows[0].querySelector('.tree-toggle').textContent, '\u25B6');
    assert.equal(h.rows[0].attributes['aria-expanded'], 'false');
    const retry = h.request(42);
    assert.notEqual(retry.requestId, request.requestId);
  }
});
test('crash, cancel and loading retire replies and prevent lazy stale-tree revival', () => {
  for (const [command, data] of [['serverCrashed', {}], ['analysisCancelled', {}], ['analysisProgress', {stage:'loading'}]]) {
    const h = harness(); h.ready(); const old = h.request(42);
    h.handlers[command](data);
    assert.equal(h.elements['reset-tree-btn'].disabled, true);
    assert.equal(h.c._tabRendered.domtree, true);
    assert.equal(h.c.acceptDominatorReply({ ...old, children: [node(43)] }), false);
    h.request(42); assert.equal(h.sent.length, 1);
    h.ready(); const fresh = h.request(42);
    assert.equal(h.c.acceptDominatorReply({ ...old, children: [] }), false);
    assert.equal(h.c.acceptDominatorReply({ ...fresh, children: [] }), true);
    assert.equal(h.elements['dominator-status'].textContent, '');
  }
});
test('child errors reach only the matching node and remain literal text', () => {
  const h = harness(); h.ready(); const request = h.request(42);
  h.handlers.dominatorChildrenError({ ...request, requestId: 'old', error: 'wrong' });
  assert.equal(h.elements['dominator-status'].textContent, '');
  h.handlers.dominatorChildrenError({ ...request, error: '<img src=x>' });
  assert.equal(h.elements['dominator-status'].textContent, '<img src=x>');
  assert.equal(h.rows[0].attributes['aria-busy'], undefined);
  h.request(42); assert.equal(h.sent.length, 2);
});
test('separate editor adapters never share pending or denominator state', () => {
  const a = harness(), b = harness(); a.ready(); b.ready();
  const request = a.request(42);
  assert.equal(b.c.acceptDominatorReply({ ...request, children: [] }), false);
  a.handlers.serverCrashed({});
  const second = b.request(42);
  assert.equal(b.c.acceptDominatorReply({ ...second, children: [] }), true);
  assert.equal(b.rows[0].querySelector('.tree-pct').textContent, '25.0%');
});
