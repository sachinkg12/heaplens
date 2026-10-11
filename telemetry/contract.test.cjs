'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { schema, record, envelope } = require('./contract.cjs');
const { Telemetry } = require('./node.cjs');
const context = {host:'vscode',version:'1.0.32',os:'darwin',arch:'arm64'};
const tick = () => new Promise(resolve => setImmediate(resolve));
test('every event rejects unapproved fields, raw text, identities and non-finite metrics', () => {
    for (const name of Object.keys(schema.events)) {
        assert.ok(record(name,context));
        for (const field of ['path','query','source','apiKey','className','errorSummary','sessionId','userId','__proto__']) {
            assert.equal(record(name,context,JSON.parse(`{"${field}":"private-canary"}`)),null);
        }
    }
    for (const value of ['private', -1, Infinity, NaN, 86400001]) {
        assert.equal(record('analysis/completed',context,{}, {durationMs:value}),null);
    }
    assert.equal(record('__proto__',context),null);
    assert.equal(record('analysis/failed',context,{errorType:'private filename'}),null);
});
test('final Azure body contains only contract fields, quantized metrics and no identity tags', () => {
    const event = record('analysis/completed',context,{}, {durationMs:1234, objectCount:4321, heapSizeMB:95});
    const body = envelope(event,'2026-10-08T00:00:00.000Z');
    assert.deepEqual(body.tags,{});
    assert.deepEqual(body.data.baseData.measurements,{durationMs:1200,objectCount:4000,heapSizeMB:64});
    assert.deepEqual(Object.keys(body.data.baseData.properties).sort(),['arch','host','os','schemaVersion','version']);
    assert.equal(record('analysis/started',{...context,version:'/Users/private'}).properties.version,'unknown');
});
test('off and development/CI override send zero requests; errors-only excludes usage', async () => {
    for (const options of [{level:'off'},{level:'all',disabled:true}]) {
        const sent=[]; const client=new Telemetry({context,...options,send:body=>sent.push(body)});
        client.track('analysis/failed',{errorType:'unknown'}); await tick(); assert.equal(sent.length,0); client.dispose();
    }
    const sent=[]; const client=new Telemetry({context,level:'error',send:(body,done)=>{sent.push(JSON.parse(body));done(true);}});
    client.track('analysis/completed'); client.track('analysis/failed',{errorType:'parse',phase:'loading'});
    await tick(); assert.equal(sent.length,1); assert.equal(sent[0].data.baseData.name,'heaplens/analysis/failed');
    assert.equal(client.report().accepted,1); client.dispose();
});
test('withdrawal cancels in-flight delivery, clears queued records and never replays them', async () => {
    const sent=[],callbacks=[];let cancelled=0;
    const client=new Telemetry({context,level:'all',send:(body,done)=>{sent.push(body);callbacks.push(done);return()=>cancelled++;}});
    client.track('analysis/started');client.track('analysis/completed');await tick();
    client.setLevel('off');callbacks[0](true);await tick();
    assert.equal(sent.length,1);assert.equal(cancelled,1);assert.equal(client.report().accepted,0);
    client.setLevel('all');await tick();assert.equal(sent.length,1);client.dispose();
});
test('transport exceptions, duplicate callbacks and queue saturation cannot affect analysis', async () => {
    const client=new Telemetry({context,level:'all',send:()=>{throw Error('private transport error');}});
    for(let i=0;i<500;i++)client.track('analysis/started');await tick();
    assert.ok(client.report().submitted<=16);assert.ok(client.report().dropped>0);
    assert.ok(!JSON.stringify(client.report()).includes('private transport error'));client.dispose();
});
test('physical HTTPS adapter uses the fixed destination and exact filtered body without redirects or SDK fields',async()=>{
    const https=require('node:https'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
    const request=https.request,calls=[];
    https.request=(url,options,response)=>{
        const req=new EventEmitter();req.destroy=()=>{};
        req.end=body=>{calls.push({url,options,body:JSON.parse(body)});const res=new PassThrough();res.statusCode=200;response(res);res.end('{}');};return req;
    };
    try{
        const {azureSend}=require('./node.cjs');let result;
        azureSend(JSON.stringify(envelope(record('analysis/failed',context,{errorType:'parse',phase:'loading'}))),ok=>{result=ok;});
        await tick();assert.equal(result,true);assert.equal(calls.length,1);assert.equal(calls[0].url,schema.endpoint);
        assert.deepEqual(Object.keys(calls[0].options.headers).sort(),['Content-Length','Content-Type']);
        assert.deepEqual(calls[0].body.tags,{});assert.equal(calls[0].body.data.baseData.properties.phase,'loading');
    }finally{https.request=request;}
});
