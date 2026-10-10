'use strict';
const http = require('node:http'), fs = require('node:fs/promises'), sync = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Sources } = require('./sources.cjs'), { Session } = require('./session.cjs');
const {Telemetry}=require('../telemetry/node.cjs');
const {platform,architecture}=require('../telemetry/contract.cjs');
class BrowserHost {
    constructor(options) {
        this.server = options.server;
        this.telemetry=new Telemetry({context:{host:'browser',version:require('../package.json').version,os:platform(process.platform),arch:architecture(process.arch)},
            level:options.telemetry??'all',disabled:!!process.env.CI || process.env.DO_NOT_TRACK==='1',...(options.telemetrySend?{send:options.telemetrySend}:{})});
        this.legacy = options.legacy;
        this.sourceRoots = options.roots || [];
        this.sources = new Sources(this.sourceRoots);
        this.sessions = new Map();
        this.queue = Promise.resolve();
        this.token = crypto.randomBytes(32).toString('base64url');
        this.stopped = false;
        this.lastSeen = Date.now();
        this.seen = false;
        const assets = options.assets || path.join(__dirname, 'build');
        this.html = sync.readFileSync(path.join(assets, 'index.html'), 'utf8');
        this.providers = JSON.parse(sync.readFileSync(path.join(assets, 'providers.json'), 'utf8'));
        this.prompts = require(path.join(assets, 'prompts.cjs'));
        options.files.forEach(file => { const session = new Session(this, file); this.sessions.set(session.id, session); });
    }
    available() { return [...this.sessions.values()].filter(s => s.state === 'ready' && s.snapshot); }
    changed() { for (const s of this.sessions.values())
        if (s.state !== 'closed')
            s.emit('snapshotsChanged'); }
    slot(work) { const result = this.queue.then(() => this.stopped ? undefined : work()); this.queue = result.catch(() => { }); return result; }
    async listen(port = 0) {
        this.http = http.createServer((req, res) => this.handle(req, res));
        this.http.requestTimeout = 15000;
        this.http.headersTimeout = 10000;
        this.http.maxHeadersCount = 32;
        await new Promise((resolve, reject) => { this.http.once('error', reject); this.http.listen(port, '127.0.0.1', resolve); });
        this.port = this.http.address().port;
        this.origin = 'http://127.0.0.1:' + this.port;
        this.idle = setInterval(() => { if (Date.now() - this.lastSeen > (this.seen ? 90000 : 300000))
            this.shutdown(); }, 5000);
        this.idle.unref();
        return this;
    }
    url(id = [...this.sessions.keys()][0]) { return this.origin + '/dump/' + id + '#token=' + this.token; }
    headers(res) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"); }
    reply(res, status, data) { if (res.destroyed || res.writableEnded)
        return; this.headers(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
    authenticated(req) { const raw = req.headers['x-heaplens-token']; if (typeof raw !== 'string' || raw.length !== this.token.length)
        return false; return crypto.timingSafeEqual(Buffer.from(raw), Buffer.from(this.token)); }
    async handle(req, res) {
        try {
            if (req.headers.host !== '127.0.0.1:' + this.port)
                return this.reply(res, 403, { error: 'Invalid host' });
            const url = new URL(req.url, this.origin);
            if (url.origin !== this.origin || url.searchParams.has('token'))
                return this.reply(res, 403, { error: 'Invalid request' });
            if (req.method === 'GET' && /^\/dump\/[a-f0-9-]{36}$/.test(url.pathname) && this.sessions.get(url.pathname.split('/').at(-1))?.state !== 'closed' && this.sessions.has(url.pathname.split('/').at(-1))) {
                const nonce = crypto.randomBytes(24).toString('base64');
                this.headers(res);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(this.html.replaceAll('__NONCE__', nonce));
                return;
            }
            if (!url.pathname.startsWith('/api/') || !this.authenticated(req) || req.headers.origin && req.headers.origin !== this.origin || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin' && req.headers['sec-fetch-site'] !== 'none' || req.method === 'POST' && req.headers.origin !== this.origin)
                return this.reply(res, 403, { error: 'Unauthorized local request' });
            this.lastSeen = Date.now();
            this.seen = true;
            if (req.method === 'GET' && url.pathname === '/api/catalog')
                return this.reply(res, 200, { dumps: [...this.sessions.values()].filter(s => s.state !== 'closed').map(s => ({ id: s.id, label: s.file.label })) });
            if (req.method === 'GET' && url.pathname === '/api/events') {
                const session = this.sessions.get(url.searchParams.get('session')), after = Number(url.searchParams.get('after'));
                if (!session || session.view !== req.headers['x-heaplens-view'] || !Number.isSafeInteger(after) || after < 0 || after > session.seq)
                    return this.reply(res, 400, { error: 'Invalid event cursor or retired page' });
                while (session.events.length && session.events[0].seq <= after)
                    session.eventBytes -= session.events.shift().bytes;
                const reset = after > 0 && session.events.length && after < session.events[0].seq - 1;
                return this.reply(res, 200, { reset: !!reset, cursor: session.seq, events: reset ? [] : session.events.map(e => ({ seq: e.seq, message: e.message })) });
            }
            if (req.method === 'POST' && url.pathname === '/api/command') {
                const body = await this.body(req);
                const session = this.sessions.get(body.session);
                if (!session || !body.message || !session.commands.has(body.message.command))
                    return this.reply(res, 400, { error: 'Unsupported action' });
                // Do not keep an HTTP request open for an analysis, approval or stream.
                if (body.message.command === 'ready')
                    session.attach(req.headers['x-heaplens-view']);
                else if (session.view !== req.headers['x-heaplens-view'])
                    return this.reply(res, 403, { error: 'Retired page' });
                const generation = session.generation, view = session.view;
                // Acknowledge before running a side effect: shutdown must not
                // destroy its own HTTP response or strand the launcher's client.
                res.once('finish', () => setImmediate(() => {
                    if (this.stopped || session.view !== view)
                        return;
                    session.dispatch(body.message).catch(() => {
                        if (session.state !== 'closed' && session.generation === generation && session.view === view)
                            session.emit('localActionStatus', { message: 'Action rejected or failed. Check limits and analysis status.' });
                    });
                }));
                this.reply(res, 202, { accepted: true });
                return;
            }
            this.reply(res, 404, { error: 'Not found' });
        }
        catch {
            this.reply(res, 400, { error: 'Invalid local request' });
        }
    }
    async body(req) { if (req.headers['content-type'] !== 'application/json')
        throw Error('Expected JSON'); let bytes = 0; const chunks = []; for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 9 * 1024 * 1024)
            throw Error('Request exceeds limit');
        chunks.push(chunk);
    } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    async shutdown() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.telemetry.dispose();
        clearInterval(this.idle);
        for (const session of this.sessions.values()) {
            session.emit('browserStopped');
            session.close();
        }
        await new Promise(resolve => { if (!this.http?.listening)
            return resolve(); this.http.close(resolve); this.http.closeAllConnections(); });
    }
}
function options(argv) {
    const out = { roots: [], files: [], legacy: false, port: 0, browser: true, telemetry:'all' };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--legacy')
            out.legacy = true;
        else if (flag === '--no-browser')
            out.browser = false;
        else if (['--server', '--source-root', '--port', '--dump', '--telemetry'].includes(flag)) {
            const value = argv[++i];
            if (!value)
                throw Error('Missing argument');
            if(flag==='--telemetry') {
                if(!['off','error','all'].includes(value))throw Error('Invalid telemetry choice');
                out.telemetry=value;
            } else if (flag === '--server')
                out.server = value;
            else if (flag === '--source-root')
                out.roots.push(value);
            else if (flag === '--port')
                out.port = Number(value);
            else
                out.files.push(value);
        }
        else
            throw Error('Unknown argument');
    }
    if (!out.server || out.files.length < 1 || out.files.length > 8 || out.roots.length > 16 || !Number.isInteger(out.port) || out.port < 0 || out.port > 65535)
        throw Error('Invalid arguments');
    return out;
}
async function main(argv) {
    let host;
    try {
        const args = options(argv), files = [];
        for (const input of args.files) {
            const file = await fs.realpath(input), stat = await fs.stat(file);
            if (!stat.isFile() || !stat.size || files.some(f => f.path === file))
                throw Error('Invalid input');
            files.push({ path: file, label: path.basename(file), size: stat.size, mtime: stat.mtimeMs });
        }
        args.server = await fs.realpath(args.server);
        if (!(await fs.stat(args.server)).isFile())
            throw Error('Invalid server');
        args.roots = await Promise.all(args.roots.map(async (root) => { const real = await fs.realpath(root); if (!(await fs.stat(real)).isDirectory())
            throw Error('Invalid source root'); return real; }));
        host = await new BrowserHost({ ...args, files }).listen(args.port);
        const launch = host.url();
        process.stdout.write('HeapLens local browser (keep this terminal running):\n' + launch + '\nThis launch URL is a private session capability. Do not share it. Ctrl+C stops owned servers.\n');
        if (args.browser) {
            const launcher = process.platform === 'darwin' ? ['open', [launch]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', launch]] : ['xdg-open', [launch]];
            const browser = spawn(launcher[0], launcher[1], { stdio: 'ignore', windowsHide: true });
            browser.on('error', () => process.stderr.write('Could not open a browser. Paste the private launch URL above.\n'));
        }
        for (const signal of ['SIGINT', 'SIGTERM'])
            process.once(signal, () => host.shutdown());
        // Retire the service if its foreground CLI parent exits unexpectedly.
        const parent = process.ppid;
        const check = setInterval(() => { try {
            process.kill(parent, 0);
        }
        catch {
            clearInterval(check);
            host.shutdown();
        } }, 3000);
        check.unref();
    }
    catch {
        await host?.shutdown();
        process.stderr.write('Cannot start local browser. Check Node runtime, built browser assets, server binary, dump/source paths and port.\n');
        process.exitCode = 3;
    }
}
if (require.main === module)
    main(process.argv.slice(2));
module.exports = { BrowserHost, options, main };
