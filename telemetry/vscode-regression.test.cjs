'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module'),https=require('node:https');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {schema}=require('./contract.cjs');
const path=require('node:path');
const root=path.resolve(process.env.HEAPLENS_VSCODE_TEST_ROOT||path.join(__dirname,'..'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let currentEditor;
const editorProxy=new Proxy({}, {
    get:(_target,key)=>currentEditor?.[key],ownKeys:()=>Reflect.ownKeys(currentEditor||{}),
    getOwnPropertyDescriptor:()=>({configurable:true,enumerable:true})
});

// Real pinned Microsoft SDK and its serializer. Only editor APIs and the final
// HTTPS connection are mocked; no test can send live Azure events or real IDs.
async function adapter(state,run){
    const load=Module._load,request=https.request,fetch=global.fetch;
    const environment={CI:process.env.CI,DO_NOT_TRACK:process.env.DO_NOT_TRACK};
    delete process.env.CI;delete process.env.DO_NOT_TRACK;
    if(state.ci)process.env.CI='1';if(state.dnt)process.env.DO_NOT_TRACK='1';
    const wire=[],instances=[],logs=[],commands=new Map(),config=[],permissions=[],sdkRequests=[],reviews=[];
    let sdkLoads=0,unexpectedFetches=0;
    class Emitter{
        constructor(){this.listeners=new Set();this.event=fn=>{this.listeners.add(fn);return{dispose:()=>this.listeners.delete(fn)};};}
        fire(event){for(const fn of this.listeners)fn(event);}
        dispose(){this.listeners.clear();}
    }
    const hostUsage=()=>state.enabled!==false && (state.host??'all')==='all';
    const hostErrors=()=>state.enabled!==false && ['all','error'].includes(state.host??'all');
    const fake={EventEmitter:Emitter,ExtensionMode:{Production:1},ConfigurationTarget:{Global:1},
        env:{machineId:state.machine||'synthetic-vscode-machine',sessionId:state.session||'synthetic-vscode-session',
            get isTelemetryEnabled(){return state.enabled!==false;},
            onDidChangeTelemetryEnabled:fn=>{permissions.push(fn);return{dispose(){}};},
            createTelemetryLogger(sender,options){
                const change=new Emitter();
                const logger={options,sender,get isUsageEnabled(){return hostUsage();},get isErrorsEnabled(){return hostErrors();},
                    onDidChangeEnableStates:change.event,
                    logUsage(name,data){if(hostUsage())send(name,data);},
                    logError(name,data){if(hostErrors())send(name,data);},dispose(){change.dispose();}};
                function send(name,data){
                    const properties={...(options.ignoreBuiltInCommonProperties?{}:{'common.privatePath':'PRIVATE_HOST_PATH'}),
                        ...options.additionalCommonProperties,...data.properties};
                    sender.sendEventData('guptasachinn.heaplens/'+name,{...data,properties});
                }
                logs.push(logger);return logger;
            }},
        workspace:{getConfiguration:section=>({get:()=>state.host??'all',inspect:()=>({globalValue:state.choice,
            defaultValue:require(path.join(root,'package.json')).contributes.configuration.properties['heaplens.telemetry.level'].default,
            workspaceValue:state.workspace??'all'}),update:async(key,value)=>{state.choice=value;}}),
            onDidChangeConfiguration:fn=>{config.push(fn);return{dispose(){}};},
            openTextDocument:async document=>{reviews.push(document.content);return document;}},
        commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return{dispose(){}};}},
        window:{showQuickPick:async()=>state.selection,showTextDocument:async document=>document}};
    currentEditor=fake;
    const file=require.resolve(path.join(root,'out/telemetry')),boundary=require.resolve(path.join(root,'out/vscodeTelemetry'));
    for(const key of [file,boundary])delete require.cache[key];
    https.request=(url,options,respond)=>{
        const req=new EventEmitter();let destroyed=false;
        req.destroy=()=>{destroyed=true;};
        req.end=body=>{
            const parsed=JSON.parse(body),packets=Array.isArray(parsed)?parsed:[parsed];
            const item={url:String(url),options,packets,aborted:()=>destroyed};wire.push(item);
            if(state.pending)return;
            const response=new PassThrough();response.statusCode=200;response.headers={};respond(response);
            response.end(JSON.stringify({itemsReceived:packets.length,itemsAccepted:packets.length,errors:[]}));
        };return req;
    };
    global.fetch=async()=>{unexpectedFetches++;throw Error('No external network allowed');};
    Module._load=function(name,parent,main){
        if(name==='vscode')return editorProxy;
        if(name==='@vscode/extension-telemetry'){
            sdkLoads++;if(state.failSdk)throw Error('PRIVATE SDK initialization error');
            const actual=load.call(this,name,parent,main);
            return{...actual,TelemetryReporter:class extends actual.TelemetryReporter{
                constructor(...args){
                    const send=args[3];args[3]=(url,init)=>{sdkRequests.push({url,method:init?.method,bytes:init?.body?.length});return send(url,init);};
                    super(...args);instances.push(this);
                }
            }};
        }
        return load.call(this,name,parent,main);
    };
    let api;
    const h={wire,instances,logs,commands,sdkRequests,reviews,get sdkLoads(){return sdkLoads;},
        packets:()=>wire.flatMap(item=>item.packets),
        changed:()=>config.forEach(fn=>fn({affectsConfiguration:()=>true})),
        permissionChanged:()=>{permissions.forEach(fn=>fn());logs.forEach(logger=>{
            // The real editor independently updates its TelemetryLogger permission.
            if(!hostUsage())logger.sender.flush();
        });},
        settle:async()=>{await tick();await tick();},
        flush:async()=>{await tick();await tick();for(const sdk of [...instances])await sdk.dispose();await tick();},
        report:()=>commands.get('heaplens.reviewDiagnostics')()};
    try{
        api=require(file);api.initTelemetry({extensionMode:state.mode??1,subscriptions:[],extension:{packageJSON:{version:'1.0.35'}}});
        await run(api,h);await api.disposeTelemetry();await tick();
        assert.equal(unexpectedFetches,0,'SDK must use only the intercepted fixed-destination transport');
        for(const item of wire)assert.equal(item.url,schema.endpoint);
    }finally{
        await api?.disposeTelemetry();Module._load=load;https.request=request;global.fetch=fetch;
        for(const key of [file,boundary])delete require.cache[key];
        for(const[key,value]of Object.entries(environment))if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
}
const name=packet=>packet.data.baseData.name;
const usage=packet=>name(packet).endsWith('/analysis/completed');

test('real SDK restores machine/session envelope IDs for filtered VS Code usage only',async()=>{
    await adapter({},async(api,h)=>{
        api.trackEvent('analysis/completed',{}, {durationMs:1234,objectCount:4321,heapSizeMB:95});
        await h.flush();assert.equal(h.sdkLoads,1);
        const packets=h.packets();assert.equal(packets.length,1,JSON.stringify(h.sdkRequests));const packet=packets[0];
        assert.ok(usage(packet));
        assert.equal(packet.tags['ai.user.id'],'synthetic-vscode-machine');
        assert.equal(packet.tags['ai.session.id'],'synthetic-vscode-session');
        assert.deepEqual(packet.data.baseData.measurements,{durationMs:1200,objectCount:4000,heapSizeMB:64});
        assert.deepEqual(Object.keys(packet.data.baseData.properties).sort(),['arch','host','os','schemaVersion','version']);
        assert.equal(packet.data.baseData.properties.host,'vscode');
        assert.equal(h.logs[0].options.ignoreUnhandledErrors,true);
        assert.equal(h.logs[0].options.ignoreBuiltInCommonProperties,true);
    });
});
test('unknown events, raw text, paths, identities and invalid metrics never reach the SDK payload',async()=>{
    await adapter({},async(api,h)=>{
        for(const properties of [{errorSummary:'PRIVATE_PERSON_SECRET.hprof'},{path:'/PRIVATE_PATH'},
            {sessionId:'PRIVATE_ID'},{className:'PRIVATE_CLASS'},{provider:'PRIVATE_PROVIDER'}])
            api.trackEvent('analysis/failed',properties);
        api.trackEvent('PRIVATE_EVENT');api.trackEvent('analysis/completed',{}, {durationMs:NaN});
        api.trackEvent('analysis/failed',{errorType:'parse',phase:'loading'});
        await h.flush();const packets=h.packets();assert.equal(packets.length,1);
        assert.equal(name(packets[0]),'heaplens/analysis/failed');assert.deepEqual(packets[0].tags,{});
        assert.ok(!JSON.stringify(packets).includes('PRIVATE_'));
    });
});
test('Off, crash-only, invalid policy, CI, development and DNT never initialize SDK or send',async()=>{
    for(const state of [{choice:'off'},{host:'off'},{host:'crash'},{host:'invalid',choice:'error'},
        {choice:'invalid',host:'error'},{enabled:false},{mode:2},{mode:3},{ci:true},{dnt:true}]){
        await adapter(state,async(api,h)=>{
            api.trackEvent('analysis/completed');api.trackEvent('analysis/failed',{errorType:'parse'});
            await h.settle();assert.equal(h.sdkLoads,0);assert.equal(h.wire.length,0);
        });
    }
});
test('Errors Only sends structured failures without SDK/counting IDs; workspace cannot override policy',async()=>{
    for(const state of [{host:'error'},{choice:'error'},{choice:'error',workspace:'all'}]){
        await adapter(state,async(api,h)=>{
            api.trackEvent('analysis/completed');api.trackEvent('analysis/failed',{errorType:'parse'});
            await h.settle();assert.equal(h.sdkLoads,0);assert.equal(h.packets().length,1);
            assert.deepEqual(h.packets()[0].tags,{});
        });
    }
    await adapter({workspace:'off'},async(api,h)=>{api.trackEvent('analysis/completed');await h.flush();assert.equal(h.packets().length,1);});
    await adapter({choice:'off',workspace:'all'},async(api,h)=>{api.trackEvent('analysis/completed');await h.settle();assert.equal(h.wire.length,0);});
});
test('withdrawal before SDK initialization/flush drops queued usage and never replays it on re-enable',async()=>{
    const state={};
    await adapter(state,async(api,h)=>{
        api.trackEvent('analysis/started');state.choice='off';h.changed();await h.settle();await h.flush();
        assert.equal(h.wire.length,0);
        state.choice='all';h.changed();await h.settle();await h.flush();assert.equal(h.wire.length,0);
    });
});
test('physical delivery rechecks application/editor permission even before notification callbacks',async()=>{
    for(const field of ['choice','enabled','host']){
        const state={};await adapter(state,async(api,h)=>{
            api.trackEvent('analysis/completed');state[field]=field==='enabled'?false:'off';
            await h.flush();assert.equal(h.wire.length,0);
        });
    }
});
test('runtime opt-out aborts SDK requests and old disposal cannot suppress a replacement',async()=>{
    const state={pending:true};
    await adapter(state,async(api,h)=>{
        api.trackEvent('analysis/completed');const flushing=h.flush();await h.settle();
        assert.equal(h.wire.length,1);state.choice='off';h.changed();await h.settle();
        assert.equal(h.wire[0].aborted(),true);await flushing;
        state.pending=false;state.choice='all';h.changed();await h.settle();
        api.trackEvent('analysis/completed');await h.flush();assert.equal(h.wire.length,2);
        assert.ok(usage(h.packets().at(-1)));
    });
});
test('normal shutdown flushes allowed usage; SDK failure never stops structured errors or analysis',async()=>{
    await adapter({},async(api,h)=>{api.trackEvent('analysis/completed');await h.settle();await api.disposeTelemetry();assert.equal(h.packets().length,1);});
    await adapter({failSdk:true},async(api,h)=>{
        assert.doesNotThrow(()=>api.trackEvent('analysis/completed'));
        api.trackEvent('analysis/failed',{errorType:'parse'});await h.settle();
        assert.equal(h.packets().length,1);assert.deepEqual(h.packets()[0].tags,{});
        assert.ok(!JSON.stringify(h.packets()).includes('PRIVATE'));
    });
});
test('SDK usage admission is bounded and errors cannot accidentally duplicate usage',async()=>{
    await adapter({},async(api,h)=>{
        for(let i=0;i<300;i++)api.trackEvent('analysis/completed');
        api.trackEvent('analysis/failed',{errorType:'parse'});await h.flush();
        assert.equal(h.packets().filter(usage).length,256);
        assert.equal(h.packets().filter(packet=>name(packet)==='heaplens/analysis/failed').length,1);
    });
});

test('separate editor sessions keep the SDK machine ID and get their supplied VS Code session IDs',async()=>{
    const ids=[];
    for(const session of ['synthetic-session-one','synthetic-session-two']){
        await adapter({session},async(api,h)=>{
            api.trackEvent('analysis/completed');await h.flush();assert.equal(h.packets().length,1);
            const tags=h.packets()[0].tags;ids.push([tags['ai.user.id'],tags['ai.session.id']]);
        });
    }
    assert.deepEqual(ids,[['synthetic-vscode-machine','synthetic-session-one'],['synthetic-vscode-machine','synthetic-session-two']]);
});
test('Errors Only withdrawal discards queued usage; local review omits IDs and documents SDK enrichment',async()=>{
    const state={};await adapter(state,async(api,h)=>{
        api.trackEvent('analysis/completed');state.choice='error';h.changed();
        api.trackEvent('analysis/failed',{errorType:'timeout'});await h.flush();
        assert.equal(h.packets().length,1);assert.deepEqual(h.packets()[0].tags,{});
        await h.report();assert.equal(h.reviews.length,1);
        assert.match(JSON.parse(h.reviews[0]).note,/SDK machine\/session IDs/);
        assert.ok(!h.reviews[0].includes('synthetic-vscode-'));assert.equal(h.sdkLoads,1);
    });
});

test('extension deactivation awaits the permitted SDK shutdown instead of abandoning its batch',async()=>{
    const exports={};let finish,finished=false;
    const waiting=new Promise(resolve=>{finish=resolve;});
    require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve(path.join(root,'out/extension')),'utf8'),{
        exports,require:name=>name==='./telemetry'?{disposeTelemetry:()=>waiting}:name==='./sourceResolver'?{setDependencyResolver(){}}:{},
        __dirname:'/synthetic/extension/out',process
    });
    const pending=exports.deactivate().then(()=>{finished=true;});await tick();assert.equal(finished,false);
    finish();await pending;assert.equal(finished,true);
});
