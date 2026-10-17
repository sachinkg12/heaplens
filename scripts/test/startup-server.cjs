#!/usr/bin/env node
'use strict';

// Controlled JSON-RPC fixture for the real extension-host startup regression.
// Completion is withheld until the test has observed the shallow view paint.
const readline = require('node:readline');
let active;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const summary = {
  total_instances: 2, total_arrays: 1, total_classes: 1, total_gc_roots: 1,
  total_heap_size: 64, reachable_heap_size: 64, unreachable_heap_size: 0
};
const histogram = [{ class_name: 'startup.Control', instance_count: 2, shallow_size: 64, retained_size: 64 }];
const notify = (method, params) => send({ method, params });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const reply = result => send({ id: request.id, result });
  if (request.method === 'analyze_heap') {
    active = request.id;
    reply({ status: 'processing', request_id: active });
    setTimeout(() => notify('heap_analysis_progress', {
      request_id: active, stage: 'sizing', snapshot: { kind: 'records', instances: 1, arrays: 0, classes: 1, roots: 1 }
    }), 100);
    setTimeout(() => notify('heap_analysis_progress', {
      request_id: active, stage: 'shallow_ready', snapshot: {
        kind: 'shallow', summary, class_histogram: histogram
      }
    }), 250);
  } else if (request.method === 'test_release') {
    reply({ released: true });
    notify('heap_analysis_complete', {
      request_id: active, status: 'completed', summary, class_histogram: histogram,
      top_objects: [], top_layers: [], leak_suspects: [], object_leak_suspects: [],
      storage: { mode: 'memory', cache_status: 'disabled' }
    });
  } else if (request.method === 'cancel_analysis') {
    reply({ cancelled: true });
    notify('heap_analysis_complete', { request_id: active, status: 'cancelled' });
  } else if (request.method === 'ping') {
    reply({ pong: true });
  } else {
    reply({});
  }
});
