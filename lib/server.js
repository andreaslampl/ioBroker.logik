'use strict';

/*
 * Web server for the editor:
 *   /                 editor (www/)
 *   /api/catalog      block definitions
 *   /api/programs     GET list, POST new (?template=solarium), PUT /api/programs/<id>, DELETE /api/programs/<id>
 *   /api/states?q=    data point search for the state picker
 *   /ws               live values ({type: 'watch', program} -> {type: 'live', ...})
 * Optional access key (?key=) for everything.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { catalog } = require('./blocks');

const WWW = path.join(__dirname, '..', 'www');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

class LogicServer {
    /**
     * @param {object} options
     * @param {object} options.store {list(), create(data, template), save(id, data), remove(id)} programs
     * @param {(q: string, exact: boolean) => Promise<Array>} options.searchStates
     * @param {import('./engine').Engine} options.engine
     */
    constructor({ store, searchStates, engine, accessKey = '', log }) {
        this.store = store;
        this.searchStates = searchStates;
        this.engine = engine;
        this.accessKey = accessKey;
        this.log = log;
        this.server = http.createServer((req, res) => {
            this._handle(req, res).catch(err => {
                this.log.warn(`Editor: ${err.message}`);
                if (!res.headersSent) {
                    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                }
                res.end(err.message);
            });
        });
        this.wss = new WebSocketServer({ noServer: true });
        this.server.on('upgrade', (req, socket, head) => {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname !== '/ws' || !this._allowed(url)) {
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(req, socket, head, ws => this._client(ws));
        });
        // live values: at most every 300 ms per program
        this.pending = new Set();
        this.onEvaluated = id => {
            if (!this.pending.has(id)) {
                this.pending.add(id);
                setTimeout(() => {
                    this.pending.delete(id);
                    this._pushLive(id);
                }, 300);
            }
        };
        engine.on('evaluated', this.onEvaluated);
    }

    listen(port, host = '0.0.0.0') {
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(port, host, () => {
                this.server.removeListener('error', reject);
                resolve(this.server.address());
            });
        });
    }

    close() {
        this.engine.removeListener('evaluated', this.onEvaluated);
        for (const ws of this.wss.clients) {
            ws.terminate();
        }
        this.server.closeAllConnections();
        return new Promise(resolve => this.server.close(() => resolve()));
    }

    _allowed(url) {
        return !this.accessKey || url.searchParams.get('key') === this.accessKey;
    }

    _json(res, status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(data === undefined ? '' : JSON.stringify(data));
    }

    async _body(req) {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
            size += c.length;
            if (size > 2e6) {
                throw new Error('Program too large');
            }
            chunks.push(c);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        return text ? JSON.parse(text) : {};
    }

    async _handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname;
        // the key protects the API and live values; the editor files themselves are no secret
        if (p.startsWith('/api/') && !this._allowed(url)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Forbidden: missing or wrong ?key=');
            return;
        }
        if (p === '/api/catalog') {
            return this._json(res, 200, catalog());
        }
        if (p === '/api/programs' && req.method === 'GET') {
            return this._json(res, 200, this.store.list());
        }
        if (p === '/api/programs' && req.method === 'POST') {
            const created = await this.store.create(await this._body(req), url.searchParams.get('template'));
            this._broadcast({ type: 'programs' });
            return this._json(res, 200, created);
        }
        const m = /^\/api\/programs\/([^/]+)$/.exec(p);
        if (m && req.method === 'PUT') {
            const saved = await this.store.save(decodeURIComponent(m[1]), await this._body(req));
            this._broadcast({ type: 'programs' });
            return this._json(res, 200, saved);
        }
        if (m && req.method === 'DELETE') {
            await this.store.remove(decodeURIComponent(m[1]));
            this._broadcast({ type: 'programs' });
            return this._json(res, 204);
        }
        if (p === '/api/states') {
            return this._json(res, 200, await this.searchStates(url.searchParams.get('q') || '', url.searchParams.get('exact') === '1'));
        }
        const file = p === '/' ? 'index.html' : p.slice(1);
        if (/^[\w.-]+$/.test(file) && TYPES[path.extname(file)]) {
            const full = path.join(WWW, file);
            if (fs.existsSync(full)) {
                res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
                fs.createReadStream(full).pipe(res);
                return;
            }
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    }

    _client(ws) {
        ws.watch = null;
        ws.on('message', data => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'watch') {
                    ws.watch = msg.program || null;
                    this._pushLive(ws.watch, ws);
                }
            } catch {
                // ignore
            }
        });
    }

    _send(ws, msg) {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify(msg));
        }
    }

    _broadcast(msg) {
        for (const ws of this.wss.clients) {
            this._send(ws, msg);
        }
    }

    _pushLive(programId, only) {
        if (!programId) {
            return;
        }
        const snap = this.engine.snapshot(programId);
        if (!snap) {
            return;
        }
        for (const ws of only ? [only] : this.wss.clients) {
            if (ws.watch === programId) {
                this._send(ws, { type: 'live', ...snap });
            }
        }
    }
}

module.exports = { LogicServer };
