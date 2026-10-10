'use strict';
const schema = require('./contract.json');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function record(name, context, properties = {}, measurements = {}) {
    if (!properties || typeof properties!=='object' || Array.isArray(properties) || !measurements || typeof measurements!=='object' || Array.isArray(measurements)) return null;
    if (!own(schema.events, name) || !schema.hosts.includes(context.host) ||
        !schema.platforms.includes(context.os) || !schema.architectures.includes(context.arch)) return null;
    const event = schema.events[name], props = {} , metrics = {};
    for (const [key, value] of Object.entries(properties)) {
        if (!event.properties.includes(key) || !schema.enums[key].includes(value)) return null;
        props[key] = value;
    }
    for (const [key, value] of Object.entries(measurements)) {
        if (!event.measurements.includes(key)) return null;
        const bound = schema.metrics[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > bound.max) return null;
        metrics[key] = Math.floor(value / bound.quantum) * bound.quantum;
    }
    const version = /^(?:unknown|[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[a-z0-9.-]{1,24})?)$/.test(context.version) ? context.version : 'unknown';
    return { name, category: event.category, properties: {
        schemaVersion: String(schema.schemaVersion), host: context.host, version, os: context.os, arch: context.arch, ...props
    }, measurements: metrics };
}
function envelope(event, time = new Date().toISOString()) {
    return { ver: 1, name: 'Microsoft.ApplicationInsights.Event', time, iKey: schema.instrumentationKey,
        tags: {}, data: { baseType: 'EventData', baseData: { ver: 2, name: 'heaplens/' + event.name,
            properties: event.properties, measurements: event.measurements } } };
}
const platform = value => schema.platforms.includes(value) ? value : 'unknown';
const architecture = value => ({ aarch64:'arm64', arm64:'arm64', x86_64:'x64', amd64:'x64', x64:'x64' }[value] || 'unknown');
module.exports = { schema, record, envelope, platform, architecture };
