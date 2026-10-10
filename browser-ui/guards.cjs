'use strict';
const requestId = m => { if (typeof m.requestId !== 'string' || !/^[\w-]{1,80}$/.test(m.requestId))
    throw Error('Invalid request ID'); return m.requestId; };
const objectId = (m, root = false) => { if (!Number.isSafeInteger(m.objectId) || m.objectId < (root ? 0 : 1))
    throw Error('Unsupported object ID'); return m.objectId; };
const bounded = (s, n) => { if (typeof s !== 'string' || !s.trim() || Buffer.byteLength(s) > n)
    throw Error('Input exceeds limit'); return s; };
module.exports = { requestId, objectId, bounded };
