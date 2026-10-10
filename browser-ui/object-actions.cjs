'use strict';
const { requestId, objectId, bounded } = require('./guards.cjs');
const reads = { gcRootPath: ['gc_root_path', 'gcRootPathResponse', 'path'], getReferrers: ['get_referrers', 'referrersResponse', 'referrers'], inspectObject: ['inspect_object', 'inspectObjectResponse', 'fields'], getDominatorSubtree: ['get_dominator_subtree', 'dominatorSubtreeResponse', 'subtree'] };
const actions = {
    async query(m) {
        const inline = m.command === 'aiRunQuery';
        const id = inline ? requestId(m) : undefined;
        try {
            const query = bounded(m.query, 16384);
            const page = m.page === undefined ? 1 : m.page;
            if (!Number.isSafeInteger(page) || page < 1 || page > 1000000)
                throw Error();
            const result = await this.engine('execute_query', { query, page, page_size: 500 });
            this.emit(inline ? 'aiQueryResult' : 'queryResult', { result, query, requestId: id });
        }
        catch {
            this.emit(inline ? 'aiQueryError' : 'queryError', { requestId: id, error: 'HeapQL failed or analysis changed. Check syntax, limits and server status.' });
        }
    },
    async instances(m) {
        const id = requestId(m);
        try {
            const name = bounded(m.className, 1024).replaceAll("'", "''");
            const result = await this.engine('execute_query', { query: "SELECT object_id, node_type, class_name, shallow_size, retained_size FROM instances WHERE class_name = '" + name + "' ORDER BY retained_size DESC LIMIT 200", page: 1, page_size: 200 });
            this.emit('histogramInstancesResult', { requestId: id, className: m.className, result });
        }
        catch {
            this.emit('histogramInstancesError', { requestId: id, className: m.className, error: 'Instance preview unavailable. Retry after analysis.' });
        }
    },
    async children(m) {
        const id = requestId(m);
        try {
            const children = await this.engine('get_children', { object_id: objectId(m) });
            this.emit('dominatorChildrenResult', { requestId: id, objectId: m.objectId, children });
        }
        catch {
            this.emit('dominatorChildrenError', { requestId: id, objectId: m.objectId, error: 'Children unavailable. Retry after analysis.' });
        }
    },
    async read(m) {
        const id = requestId(m), [method, reply, field] = reads[m.command];
        try {
            const params = { object_id: objectId(m, m.command === 'getDominatorSubtree') };
            if (m.command === 'getDominatorSubtree')
                Object.assign(params, { max_depth: 6, max_children: 20 });
            const result = await this.engine(method, params);
            this.emit(reply, { requestId: id, objectId: m.objectId, [field]: result });
        }
        catch {
            this.emit(reply, { requestId: id, objectId: m.objectId, error: 'Object data unavailable or ID unsupported. Retry after analysis.' });
        }
    }
};
module.exports.install = session => {
    for (const [name, action] of Object.entries(actions))
        session[name] = action.bind(session);
    for (const [command, handler] of Object.entries({ executeQuery: m => session.query(m), aiRunQuery: m => session.query(m), histogramInstances: m => session.instances(m), dominatorChildren: m => session.children(m), ...Object.fromEntries(Object.keys(reads).map(command => [command, m => session.read(m)])) }))
        session.commands.set(command, handler);
};
