import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { histogramHarness as harness, Entry, Analysis } from './histogramHarness';

const classes: Entry[] = [
    { class_name: 'example.Owner', instance_count: 2, shallow_size: 32, retained_size: 50 },
    { class_name: 'example.Array', instance_count: 1, shallow_size: 75, retained_size: 75 },
    { class_name: 'example.Container', instance_count: 3, shallow_size: 48, retained_size: 75 }
];
function analysis(reachable: unknown = 100, entries = classes): Analysis {
    // Deliberately different: unreachable bytes must not enter the denominator.
    return { summary: { reachable_heap_size: reachable, total_heap_size: 400 }, classHistogram: entries };
}

function loaded(data: Analysis = analysis()) {
    const h = harness(); h.complete(data); h.activate(); return h;
}

test('Histogram percentages use reachable heap rather than overlapping class totals, including CSV', () => {
    const data = analysis(), unchanged = JSON.stringify(data), h = loaded(data);
    assert.deepEqual(h.rows(), [
        ['example.Array', '1', '75 B', '75 B', '75.0%'],
        ['example.Container', '3', '48 B', '75 B', '75.0%'],
        ['example.Owner', '2', '32 B', '50 B', '50.0%']
    ]);
    assert.equal(h.csv(), 'Class Name,Instances,Shallow Size,Retained Size,% of Heap\n'
        + '"example.Array",1,75,75,75.0\n"example.Container",3,48,75,75.0\n"example.Owner",2,32,50,50.0\n');
    assert.equal(JSON.stringify(data), unchanged, 'No engine DTO or byte value is rewritten');
});

test('Histogram already active receives its denominator before global analysisData is assigned', () => {
    const h = harness(); h.activate(); h.complete(analysis());
    assert.equal(h.rows().find(row => row[0] === 'example.Owner')?.[4], '50.0%');
});

test('filtering and sorting preserve the full reachable-heap denominator and CSV scope', () => {
    const h = loaded();
    h.sort('heap_pct'); assert.deepEqual(h.rows().map(r => r[4]), ['75.0%', '75.0%', '50.0%']);
    h.sort('heap_pct'); assert.deepEqual(h.rows().map(r => r[4]), ['50.0%', '75.0%', '75.0%']);
    h.filter('OWNER'); assert.equal(h.rows().length, 1); assert.equal(h.rows()[0][4], '50.0%');
    assert.equal(h.csv().split('\n')[1], '"example.Owner",2,32,50,50.0');
    h.filter('nothing matches'); assert.equal(h.rows().length, 0);
    assert.equal(h.csv(), 'Class Name,Instances,Shallow Size,Retained Size,% of Heap\n');
    h.filter(''); assert.equal(h.rows().length, 3);
    assert.equal(h.rows().find(row => row[0] === 'example.Owner')?.[4], '50.0%');
});

test('the 200-row display limit and Show all do not change percentages or truncate CSV', () => {
    const entries = Array.from({ length: 205 }, (_, i) => ({
        class_name: 'example.Class' + i, instance_count: 1, shallow_size: 10, retained_size: 100
    }));
    const h = loaded(analysis(10000, entries));
    assert.equal(h.rows().length, 200); assert.ok(h.rows().every(r => r[4] === '1.0%'));
    assert.equal(h.csv().trim().split('\n').length, 206);
    assert.ok(h.csv().trim().split('\n').slice(1).every(row => row.endsWith(',1.0')));
    h.showAll(); assert.equal(h.rows().length, 205); assert.ok(h.rows().every(r => r[4] === '1.0%'));
    h.sort('class_name'); assert.equal(h.rows().length, 200);
    assert.ok(h.rows().every(r => r[4] === '1.0%'));
});

for (const [label, summary] of [
    ['zero', { reachable_heap_size: 0, total_heap_size: 400 }],
    ['missing reachable field', { total_heap_size: 400 }],
    ['missing summary', undefined],
    ['negative', { reachable_heap_size: -100 }],
    ['NaN', { reachable_heap_size: NaN }],
    ['infinite', { reachable_heap_size: Infinity }],
    ['wrong type', { reachable_heap_size: '100' }]
] as const) {
    test('unavailable percentage is N/A without a total-heap fallback: ' + label, () => {
        const h = loaded({ summary, classHistogram: classes });
        assert.ok(h.rows().every(r => r[4] === 'N/A'));
        assert.ok(h.csv().trim().split('\n').slice(1).every(row => row.endsWith(',N/A')));
        h.sort('heap_pct'); h.filter('Owner'); assert.equal(h.rows()[0][4], 'N/A');
        assert.doesNotMatch(h.html() + h.csv(), /NaN|Infinity/);
    });
}

test('a zero retained size is 0.0% when the reachable heap is positive', () => {
    const h = loaded(analysis(100, [{ ...classes[0], retained_size: 0 }]));
    assert.equal(h.rows()[0][4], '0.0%'); assert.match(h.csv(), /,0,0\.0\n$/);
});

test('separate editor pages do not share their heap denominator', () => {
    const first = loaded(analysis(100)), second = loaded(analysis(200));
    first.filter('Owner'); second.filter('Owner');
    assert.equal(first.rows()[0][4], '50.0%'); assert.equal(second.rows()[0][4], '25.0%');
    assert.match(first.csv(), /,50\.0\n$/); assert.match(second.csv(), /,25\.0\n$/);
});

test('generated overlapping class sets match an independent percentage oracle', () => {
    let seed = 1729;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let round = 0; round < 40; round++) {
        const reachable = 100 + next() % 100000;
        const entries = Array.from({ length: 6 }, (_, i) => ({ class_name: 'example.Generated' + i,
            instance_count: 1, shallow_size: 8, retained_size: next() % (reachable + 1) }));
        const expected = new Map(entries.map(e => [e.class_name, ((e.retained_size * 100) / reachable).toFixed(1)]));
        const h = loaded(analysis(reachable, entries));
        for (const row of h.rows()) assert.equal(row[4], expected.get(row[0]) + '%');
        for (const row of h.csv().trim().split('\n').slice(1)) {
            const cells = row.split(','); assert.equal(cells[4], expected.get(cells[0].slice(1, -1)));
        }
    }
});
