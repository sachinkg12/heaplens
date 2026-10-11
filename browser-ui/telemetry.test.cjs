'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Telemetry}=require('../telemetry/node.cjs');
const {observe,install}=require('./telemetry-actions.cjs');
const {options,BrowserHost}=require('./server.cjs');
test('browser launch defaults on, preserves explicit off and rejects arbitrary telemetry choices',()=>{
    const args=['--server','server','--dump','dump'];
    assert.equal(options(args).telemetry,'all');assert.equal(options([...args,'--telemetry','off']).telemetry,'off');assert.equal(options([...args,'--telemetry','error']).telemetry,'error');
    assert.throws(()=>options([...args,'--telemetry','private-canary']));
});
test('browser default-on delivery is filtered and CI/do-not-track still override it',async()=>{
    const environment={CI:process.env.CI,DO_NOT_TRACK:process.env.DO_NOT_TRACK};
    const sent=[];const make=telemetry=>new BrowserHost({server:'unused',files:[],roots:[],telemetry,
        telemetrySend:(body,done)=>{sent.push(JSON.parse(body));done(true);}});
    let host;
    try{
        // This test injects the transport; no environment change can enable real delivery.
        delete process.env.CI;delete process.env.DO_NOT_TRACK;
        host=make();assert.equal(host.telemetry.level,'all');host.telemetry.track('analysis/completed');
        await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,1);assert.deepEqual(sent[0].tags,{});
        await host.shutdown();
        for(const options of [{level:'off'},{key:'CI'},{key:'DO_NOT_TRACK'}]){
            if(options.key)process.env[options.key]='1';host=make(options.level);
            assert.equal(host.telemetry.level,'off');host.telemetry.track('analysis/failed');
            await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,1);await host.shutdown();
            if(options.key)delete process.env[options.key];
        }
    }finally{await host?.shutdown();for(const[key,value]of Object.entries(environment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
test('browser observes only approved metrics, deduplicates re-render and supports withdrawal',async()=>{
    const sent=[];const telemetry=new Telemetry({context:{host:'browser',version:'1.0.32',os:'darwin',arch:'arm64'},level:'all',send:(body,done)=>{sent.push(JSON.parse(body));done(true);}});
    const session={host:{telemetry},state:'loading',generation:1,file:{size:12345,path:'private-canary'},commands:new Map([['retryAnalysis',()=>{}]]),emit:()=>{}};
    install(session);observe(session,'analysisProgress',{stage:'loading',raw:'private-canary'});
    const summary={total_instances:2345,total_classes:333,total_heap_size:104857600,private:'private-canary'};
    observe(session,'analysisComplete',{summary,source:'private-canary'});observe(session,'analysisComplete',{summary});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(sent.filter(e=>e.data.baseData.name==='heaplens/analysis/completed').length,1);
    assert.ok(!JSON.stringify(sent).includes('private-canary'));
    session.commands.get('telemetryOff')();session.commands.get('tabViewed')({tab:'source'});
    const count=sent.length;await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,count);telemetry.dispose();
});
