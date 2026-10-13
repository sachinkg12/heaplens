'use strict';
const { requestId } = require('./guards.cjs');
module.exports.install = session => {
    session.commands.set('calculateWaste', async m => {
        const id = requestId(m), original = session.raw;
        try {
            const waste = await session.engine('get_waste_analysis', {});
            if (session.raw !== original) return;
            session.raw.waste_analysis = waste;
            if (session.snapshot) {
                const totals = Object.fromEntries(['total_wasted_bytes', 'waste_percentage', 'duplicate_string_wasted_bytes', 'empty_collection_wasted_bytes', 'over_allocated_wasted_bytes', 'boxed_primitive_wasted_bytes'].map(k => [k, waste[k]]));
                session.snapshot = { ...session.snapshot, waste_analysis: totals };
                session.host.changed();
            }
            session.emit('wasteResult', { requestId: id, wasteAnalysis: waste });
        } catch {
            session.emit('wasteError', { requestId: id, error: 'Waste analysis unavailable. Retry after retained analysis completes.' });
        }
    });
};
