'use strict';
const { bounded } = require('./guards.cjs');
function safeCsv(text) {
    let cell = '', quoted = false, rows = [], row = [];
    function push() { if (/^[\s\u0000-\u001f]*[=+@\-]/.test(cell) && !/^-?\d+(?:\.\d+)?$/.test(cell))
        cell = "'" + cell; row.push('"' + cell.replaceAll('"', '""') + '"'); cell = ''; }
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            if (quoted && text[i + 1] === '"') {
                cell += '"';
                i++;
            }
            else
                quoted = !quoted;
        }
        else if (!quoted && c === ',')
            push();
        else if (!quoted && c === '\n') {
            push();
            rows.push(row.join(','));
            row = [];
        }
        else
            cell += c;
    }
    if (quoted)
        throw Error('Malformed CSV');
    if (cell || row.length) {
        push();
        rows.push(row.join(','));
    }
    return rows.join('\n');
}
const actions = {
    copy(m) { this.emit('browserCopy', { text: bounded(m.text, 8 * 1024 * 1024) }); },
    export(m, field, name) {
        let text = bounded(m[field], 8 * 1024 * 1024);
        if (field === 'csv')
            text = safeCsv(text);
        this.emit('browserDownload', { text, name, mime: field === 'csv' ? 'text/csv' : 'text/markdown' });
    }
};
module.exports.safeCsv = safeCsv;
module.exports.install = session => { for (const [name, action] of Object.entries(actions))
    session[name] = action.bind(session); for (const [command, handler] of Object.entries({ copyReportText: m => session.copy(m), exportHistogramCsv: m => session.export(m, 'csv', 'HeapLens-histogram.csv'), exportCompareCsv: m => session.export(m, 'csv', 'HeapLens-comparison.csv'), exportCompareMarkdown: m => session.export(m, 'markdown', 'HeapLens-comparison.md') }))
    session.commands.set(command, handler); };
