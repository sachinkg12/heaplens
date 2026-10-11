'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('VS Code does not instantiate an SDK with automatic identifiers or forward arbitrary errors', () => {
    const load = Module._load, sent = [];
    let sdkLoads = 0;
    const fake = {
        ExtensionMode: { Production: 1 },
        env: { isTelemetryEnabled: true, onDidChangeTelemetryEnabled: () => ({ dispose() {} }) },
        workspace: {
            getConfiguration: section => ({ get: key => section === 'telemetry' ? 'all' : 'all', inspect:()=>({globalValue:'all'}) }),
            onDidChangeConfiguration: () => ({ dispose() {} })
        },
        commands: { registerCommand: () => ({ dispose() {} }) },
        window: { showQuickPick: async () => undefined, showInformationMessage() {} }
    };
    const file = require.resolve('../out/telemetry');
    delete require.cache[file];
    Module._load = function(name, parent, main) {
        if (name === 'vscode') return fake;
        if (name === '@vscode/extension-telemetry') {
            sdkLoads++;
            return { TelemetryReporter: class {
                sendTelemetryEvent(name, properties) { sent.push({ name, properties, tags: { 'ai.user.id': 'private-machine' } }); }
                dispose() {}
            } };
        }
        return load.call(this, name, parent, main);
    };
    try {
        const telemetry = require(file);
        telemetry.initTelemetry({ extensionMode: 1, subscriptions: [], extension: { packageJSON: { version: '1.0.32', telemetryConnectionString: 'InstrumentationKey=test' } } });
        telemetry.trackEvent('analysis/failed', { errorType: 'unknown', errorSummary: 'private_person_secret.hprof' });
        telemetry.disposeTelemetry();
        assert.equal(sdkLoads, 0, 'automatic SDK metadata must not enter the payload');
        assert.equal(sent.length, 0, 'unknown raw-text fields must not be forwarded');
    } finally { Module._load = load; delete require.cache[file]; }
});

async function adapter(state,run) {
    const load=Module._load, sent=[], cancellations=[];let changed,permissionChanged;
    const environment={CI:process.env.CI,DO_NOT_TRACK:process.env.DO_NOT_TRACK};
    delete process.env.CI;delete process.env.DO_NOT_TRACK;
    if(state.ci)process.env.CI='1';if(state.dnt)process.env.DO_NOT_TRACK='1';
    const fake={ExtensionMode:{Production:1},ConfigurationTarget:{Global:1},
        env:{get isTelemetryEnabled(){return state.enabled!==false;},onDidChangeTelemetryEnabled:fn=>{permissionChanged=fn;return{dispose(){}};}},
        workspace:{getConfiguration:section=>({get:()=>state.host??'all',inspect:()=>({globalValue:state.choice,
            defaultValue:require('../package.json').contributes.configuration.properties['heaplens.telemetry.level'].default,
            workspaceValue:state.workspace??'all'})}),
            onDidChangeConfiguration:fn=>{changed=fn;return{dispose(){}};}},commands:{registerCommand:()=>({dispose(){}})}};
    const {Telemetry}=require('./node.cjs');const file=require.resolve('../out/telemetry');delete require.cache[file];
    Module._load=function(name,parent,main){if(name==='vscode')return fake;
        if(name==='../telemetry/node.cjs')return{Telemetry:class extends Telemetry{constructor(options){super({...options,send:(body,done)=>{
            sent.push(JSON.parse(body));if(!state.pending)done(true);return()=>cancellations.push(true);
        }});}}};return load.call(this,name,parent,main);};
    let api;
    try{api=require(file);api.initTelemetry({extensionMode:state.mode||1,subscriptions:[],extension:{packageJSON:{version:'1.0.32'}}});
        await run(api,sent,()=>changed({affectsConfiguration:()=>true}),()=>permissionChanged(),cancellations);
    }finally{api?.disposeTelemetry();Module._load=load;delete require.cache[file];
        for(const[key,value]of Object.entries(environment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('VS Code preserves explicit Off and editor permission; workspace values cannot override application policy',async()=>{
    for(const state of [{choice:'off'},{choice:'all',host:'off'},{choice:'all',enabled:false},{choice:'all',mode:2},{choice:'all',ci:true},{choice:'all',dnt:true}]){
        await adapter(state,async(api,sent)=>{api.trackEvent('analysis/failed',{errorType:'parse'});await tick();assert.equal(sent.length,0);});
    }
    for(const state of [{choice:'all',host:'error'},{choice:'error',host:'all'}]){
        await adapter(state,async(api,sent)=>{api.trackEvent('analysis/completed');api.trackEvent('analysis/failed',{errorType:'parse'});await tick();
            assert.equal(sent.length,1);assert.equal(sent[0].data.baseData.name,'heaplens/analysis/failed');});
    }
});
test('VS Code defaults to usage and errors but never overrides host or explicit opt-out',async()=>{
    assert.equal(require('../package.json').contributes.configuration.properties['heaplens.telemetry.level'].default,'all');
    await adapter({workspace:'off'},async(api,sent)=>{api.trackEvent('analysis/completed');await tick();assert.equal(sent.length,1);});
    for(const state of [{host:'off'},{enabled:false},{choice:'off',workspace:'all'},{choice:'invalid'},{mode:2},{ci:true},{dnt:true}]){
        await adapter(state,async(api,sent)=>{api.trackEvent('analysis/completed');await tick();assert.equal(sent.length,0);});
    }
});
test('VS Code final bodies exclude arbitrary errors; runtime opt-out clears pending usage',async()=>{
    const state={choice:'all',pending:true};
    await adapter(state,async(api,sent,changed,permission,cancelled)=>{
        api.trackEvent('analysis/failed',{errorType:'unknown',errorSummary:'private-canary'});
        api.trackEvent('analysis/started');api.trackEvent('analysis/completed');await tick();
        assert.equal(sent.length,1);assert.deepEqual(sent[0].tags,{});assert.ok(!JSON.stringify(sent).includes('private-canary'));
        state.choice='off';changed();await tick();assert.equal(cancelled.length,1);assert.equal(sent.length,1);
        state.choice='all';changed();await tick();assert.equal(sent.length,1);
        state.enabled=false;permission();api.trackEvent('analysis/failed',{errorType:'unknown'});await tick();assert.equal(sent.length,1);
    });
});
