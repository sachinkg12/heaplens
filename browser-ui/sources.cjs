'use strict';
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const MAX = 256 * 1024;
function classParts(value) {
    if (typeof value !== 'string' || value.length > 1024)
        throw Error('Invalid class name');
    const parts = value.replace(/^class /, '').replace(/(?:\[\])+$/, '').split('.');
    if (!parts.every(x => /^[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}]*$/u.test(x)))
        throw Error('Invalid class name');
    const simple = parts.at(-1), inner = simple.indexOf('$', 1);
    parts[parts.length - 1] = (inner < 0 ? simple : simple.slice(0, inner)) + '.java';
    return parts;
}
function contained(root, file) { return file === root || file.startsWith(root + path.sep); }
class Sources {
    constructor(roots) { this.roots = roots; this.files = null; }
    async index() {
        if (this.files)
            return this.files;
        const result = [];
        let visited = 0;
        for (const input of this.roots) {
            const root = input;
            if (await fs.realpath(root) !== root || !(await fs.stat(root)).isDirectory())
                throw Error('Approved source root moved or is not a directory');
            async function walk(dir) {
                for await (const entry of await fs.opendir(dir)) {
                    if (++visited > 50000)
                        throw Error('Source scope is too large. Choose a narrower source directory.');
                    if (entry.isSymbolicLink() || ['.git', 'node_modules', '.idea', 'target', 'build'].includes(entry.name))
                        continue;
                    const file = path.join(dir, entry.name);
                    if (entry.isDirectory())
                        await walk(file);
                    else if (entry.isFile() && entry.name.endsWith('.java'))
                        result.push({ root, rootIndex: thisRootIndex, file, label: path.relative(root, file) });
                }
            }
            const thisRootIndex = this.roots.indexOf(input) + 1;
            await walk(root);
        }
        this.files = result;
        return result;
    }
    async find(name) { const suffix = classParts(name).join(path.sep); const matches = (await this.index()).filter(x => x.label === suffix || x.label.endsWith(path.sep + suffix)); if (matches.length > 20)
        throw Error('Too many matching files. Choose narrower source roots.'); return matches; }
    async read(target) {
        const resolved = await fs.realpath(target.file);
        if (!contained(target.root, resolved))
            throw Error('Source moved outside approved root');
        const h = await fs.open(resolved, sync.constants.O_RDONLY | (sync.constants.O_NOFOLLOW || 0));
        try {
            const st = await h.stat();
            if (!st.isFile() || st.size > MAX)
                throw Error('Source is unavailable or exceeds 256 KiB');
            // Verify the handle still describes the confined file, not a swapped link.
            const again = await fs.realpath(target.file), current = await fs.stat(again);
            if (!contained(target.root, again) || current.ino !== st.ino || current.dev !== st.dev)
                throw Error('Source changed during lookup');
            const text = await h.readFile('utf8');
            if (Buffer.byteLength(text) > MAX)
                throw Error('Source exceeds 256 KiB');
            return text;
        }
        finally {
            await h.close();
        }
    }
}
module.exports = { Sources, classParts, contained };
