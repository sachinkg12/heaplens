import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { once } from 'events';
import { ChildProcess } from 'child_process';
import { RustClient } from '../rustClient';
import { editorHarness } from './editorHarness';

async function completed(view: {messages:any[]}): Promise<void> {
    const deadline=Date.now()+20_000;
    while(!view.messages.some(m=>m.command==='analysisComplete')) {
        if(Date.now()>deadline)throw Error('Analysis did not complete');
        await new Promise(resolve=>setTimeout(resolve,5));
    }
}

// Explicit binary only: do not install an IDE, download a server or read a user dump.
const binary = process.env.HEAPLENS_TEST_SERVER;
function fixture(): Buffer {
    const header = Buffer.alloc(12); header.writeUInt32BE(8);
    const heap = Buffer.alloc(36); heap[0] = 255; heap.writeBigUInt64BE(512n, 1);
    heap[9] = 35; heap.writeBigUInt64BE(512n, 10); heap.writeUInt32BE(9, 22); heap[26] = 8;
    const record = Buffer.alloc(9); record[0] = 28; record.writeUInt32BE(heap.length, 5);
    const end = Buffer.alloc(9); end[0] = 44;
    return Buffer.concat([Buffer.from('JAVA PROFILE 1.0.2\0'), header, record, heap, end]);
}

test('real VS Code adapter selects disk, reports reuse, and restores queries/Waste after crash', { skip: !binary, timeout: 30_000 }, async () => {
    assert.ok(binary);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heaplens-vscode-storage-'));
    const dump = path.join(directory, 'fixture.hprof'), cache = path.join(directory, 'cache');
    fs.writeFileSync(dump, fixture());
    const clients: RustClient[] = [], exits: Array<Promise<unknown>> = [];
    const host = editorHarness(args => {
        assert.deepEqual(args, ['--storage', 'disk', '--edge-buffer-mib', '64']);
        const client = new RustClient(binary, [...(args || []), '--cache-dir', cache]);
        const child = (client as unknown as { process: ChildProcess }).process;
        clients.push(client); exits.push(once(child, 'exit')); return client;
    }, 'full', 'disk');
    try {
        let view = host.panel(); await host.open(dump, view); await view.send({ command: 'ready' });
        await completed(view);
        assert.deepEqual(view.messages.at(-1)?.storage, { mode: 'disk', cache_status: 'built' });
        assert.equal(host.provider.getAnalysisData()?.wasteAnalysis, undefined);
        const query = 'SELECT object_id, shallow_size, retained_size FROM instances ORDER BY object_id';
        await view.send({ command: 'executeQuery', query }); const expected = view.messages.at(-1).result.rows;
        assert.equal(expected.length, 1);
        view.close(); await exits[0];
        view = host.panel(); await host.open(dump, view); await view.send({ command: 'ready' });
        await completed(view);
        assert.deepEqual(view.messages.at(-1)?.storage, { mode: 'disk', cache_status: 'reused' });
        const oldPid = clients[1].processId;
        const child = (clients[1] as unknown as { process: ChildProcess }).process;
        child.kill('SIGKILL'); await exits[1]; await new Promise(resolve => setImmediate(resolve));
        await view.send({ command: 'retryAnalysis' });
        assert.notEqual(clients[2].processId, oldPid);
        assert.deepEqual(view.messages.at(-1)?.storage, { mode: 'disk', cache_status: 'reused' });
        await view.send({ command: 'executeQuery', query }); assert.deepEqual(view.messages.at(-1).result.rows, expected);
        await view.send({ command: 'calculateWaste', requestId: 'storage-waste' });
        assert.equal(view.messages.at(-1).command, 'wasteResult');
        assert.equal(host.provider.getAnalysisData()?.wasteAnalysis?.total_wasted_bytes, 0);
    } finally {
        host.provider.dispose(); await Promise.all(exits);
        fs.rmSync(directory, { recursive: true, force: true }); // Exact generated directory owned by this test.
    }
});

test('one real analysis streams shallow data; bounded read bursts leave Ping and Cancel responsive', {skip:!binary,timeout:60_000}, async()=>{
    assert.ok(binary);
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'heaplens-staged-rpc-'));
    const dump=path.join(directory,'records.hprof'), count=500_000;
    const header=Buffer.alloc(12);header.writeUInt32BE(8);
    const heap=Buffer.alloc(count*28);
    for(let i=0;i<count;i++) {
        const start=i*28,id=BigInt((i+1)*32);
        heap[start]=255;heap.writeBigUInt64BE(id,start+1);
        heap[start+9]=35;heap.writeBigUInt64BE(id,start+10);
        heap.writeUInt32BE(1,start+22);heap[start+26]=8;
    }
    const record=Buffer.alloc(9);record[0]=28;record.writeUInt32BE(heap.length,5);
    fs.writeFileSync(dump,Buffer.concat([Buffer.from('JAVA PROFILE 1.0.2\0'),header,record,heap]));
    const client=new RustClient(binary,['--storage','memory']);
    const exit=once((client as unknown as {process:ChildProcess}).process,'exit');
    try {
        const progress:any[]=[];
        client.onNotification('heap_analysis_progress',p=>progress.push(p));
        const done=new Promise<any>(resolve=>client.onNotification('heap_analysis_complete',resolve));
        await client.sendRequest('analyze_heap',{path:dump});const result=await done;
        assert.equal(result.status,'completed');assert.equal(result.summary.total_arrays,count);
        const snapshot=progress.find(p=>p.snapshot?.kind==='shallow')?.snapshot;
        assert.ok(snapshot);assert.equal(snapshot.summary.reachable_heap_size,null);
        assert.equal(snapshot.readiness.retained,'not_calculated');
        assert.equal(snapshot.class_histogram.reduce((n:number,c:any)=>n+c.instance_count,0),count);
        assert.ok(snapshot.class_histogram.every((c:any)=>!Object.prototype.hasOwnProperty.call(c,'retained_size')));
        assert.equal(progress.filter(p=>p.snapshot?.kind==='shallow').length,1);
        assert.ok(progress.findIndex(p=>p.stage==='shallow_ready')<progress.findIndex(p=>p.stage==='dominators'));
        const order:string[]=[];
        const reads=Array.from({length:32},()=>client.sendRequest('execute_query',{
            path:dump,query:'SELECT object_id, retained_size FROM instances ORDER BY object_id DESC LIMIT 100'
        }).then(value=>{order.push('read');return {value};},error=>{order.push('busy');return {error};}));
        const ping=client.sendRequest('ping',{}).then(value=>{order.push('ping');return value;});
        const cancel=client.sendRequest('cancel_analysis',{path:dump,analysis_request_id:result.request_id});
        assert.equal((await ping).status,'ok');assert.equal((await cancel).cancelled,false);
        const replies=await Promise.all(reads);
        assert.ok(replies.some(r=>'error' in r));assert.ok(replies.some(r=>'value' in r));
        for(const reply of replies)if('value' in reply)assert.equal(reply.value.rows.length,100);
        assert.ok(order.indexOf('ping')<order.lastIndexOf('read'),'control request must not wait for all query jobs');
        const waste=await client.sendRequest('get_waste_analysis',{path:dump},0);
        assert.equal(waste.total_wasted_bytes,0);
    } finally {client.dispose();await exit;fs.rmSync(directory,{recursive:true,force:true});}
});
