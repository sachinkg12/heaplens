import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {chatQuerySegments} from '../webview/js/chatQueries';
import {CHAT_POLICY} from '../aiInvestigation';

const query='SELECT object_id, class_name, retained_size FROM instances ORDER BY retained_size DESC LIMIT 20';
const queries=(text:string)=>chatQuerySegments(text).flatMap(s=>s.query?[s.query]:[]);
test('shared policy requires runnable HeapQL fences but never automatic execution or result sharing',()=>{
    assert.match(CHAT_POLICY,/fenced code block tagged heapql/);assert.match(CHAT_POLICY,/NEVER executes/);assert.match(CHAT_POLICY,/results stay local/);
});
test('format recognition preserves exact queries across tags, line endings, indentation and inline/plain replies',()=>{
    for(const language of ['heapql','HeapQL','HEAPQL','sql','SQL',''])assert.deepEqual(queries('Here is a suggestion.\n\n```'+language+'\n'+query+'\n```\n\nVerify the result.'),[query],language);
    for(const text of ['```sql\r\n'+query+'\r\n```','~~~heapql\n'+query+'\n~~~','   ```heapql\n'+query+'\n   ```',query,'  '+query+'\n',
        'Suggested query:\n\n'+query+'\n\nNo execution has occurred.','Try `'+query+'` and check ownership.'])assert.deepEqual(queries(text),[query],text);
});
test('multiline selects, aggregates and inspection commands remain available',()=>{
    const multiline='SELECT object_id,\n       class_name, retained_size\nFROM instances\nORDER BY retained_size DESC\nLIMIT 20;';
    assert.deepEqual(queries('```SQL\n'+multiline+'\n```'),[multiline.slice(0,-1)]);assert.deepEqual(queries(multiline),[multiline.slice(0,-1)]);
    for(const q of ['SELECT COUNT(*) FROM class_histogram','SELECT * FROM dominator_tree WHERE object_id = 42','SELECT * FROM leak_suspects',':info 42',':path 0x2a',':refs 42',':children 0'])assert.deepEqual(queries('```\n'+q+'\n```'),[q]);
});
test('strings are not table/statement authority; semicolons inside quoted names remain exact',()=>{
    const q="SELECT class_name FROM instances WHERE class_name = 'example.Drop;Cache'";assert.deepEqual(queries('```sql\n'+q+';\n```'),[q]);
    const literal="SELECT class_name FROM instances WHERE class_name = 'Cache\r\nOwner'";assert.deepEqual(queries('```sql\r\n'+literal+';\r\n```'),[literal],'Preserve literal line endings, not just quoted semicolons');
    for(const q of ["SELECT 'FROM instances' FROM users","SELECT * FROM instances; SELECT * FROM class_histogram","SELECT * FROM instances; DROP TABLE instances",'SELECT * FROM instances -- instruction','SELECT * FROM instances /* comment */',"SELECT * FROM instances WHERE class_name = 'unclosed"])
        assert.deepEqual(queries('```sql\n'+q+'\n```'),[],q);
});
test('non-query code and prose never become executable controls',()=>{
    for(const language of ['java','javascript','bash','shell','python','json'])assert.deepEqual(queries('```'+language+'\n'+query+'\n```'),[],language);
    assert.deepEqual(queries('```javascript\n\n'+query),[],'Unclosed non-query fence must not expose its body');
    for(const q of ['DROP TABLE instances','DELETE FROM instances','SELECT * FROM users','SELECT * FROM objects','Here is SELECT * FROM instances to discuss',':path /private/dump.hprof','curl https://example.test','{"action":"read"}'])assert.deepEqual(queries(q),[],q);
});
test('multiple separate suggestions get separate controls without duplicating inline suggestions',()=>{
    assert.deepEqual(queries('```heapql\n'+query+'\n```\n\n```sql\nSELECT COUNT(*) FROM instances\n```'),[query,'SELECT COUNT(*) FROM instances']);
    const text='Try `'+query+'`.';assert.equal(queries(text).length,1);
    const segments=chatQuerySegments(text);assert.equal(segments.map(s=>s.text).join(''),text);
});
test('format recognition is bounded and never runs or rewrites the query',()=>{
    assert.equal(queries(Array.from({length:30},()=> '```heapql\n'+query+'\n```').join('\n\n')).length,16);
    assert.equal(queries('x'.repeat(65537)).length,0);
});
