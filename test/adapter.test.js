'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

/** Minimal ioBroker: foreign states and objects in memory. */
class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config;
        this.states = {};
        this.foreign = {};
        this.objects = {
            'system.config': { common: { latitude: 48.2, longitude: 16.4 } },
            'demo.booked': { common: { name: 'Türleser gebucht', type: 'boolean' } },
            'demo.solarium': { common: { name: 'Solarium Betrieb', type: 'boolean' } },
            'demo.exitMotion': { common: { name: 'Austritt Bewegungsmelder', type: 'boolean' } },
            'demo.door': { common: { name: 'Magnetkontakt Tür', type: 'boolean' } },
            'demo.dimmer': { common: { name: 'Licht Kabine', type: 'number' } },
        };
        this.writes = [];
        this.log = { debug() {}, info() {}, warn() {}, error() {} };
        this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logik-'));
    }
    async setState(id, val, ack) {
        this.states[id] = { val, ack };
    }
    async getForeignObjectAsync(id) {
        return this.objects[id] ? { _id: id, ...this.objects[id] } : null;
    }
    async getForeignObjectsAsync() {
        return Object.fromEntries(Object.entries(this.objects).filter(([id]) => id.startsWith('demo.')).map(([id, o]) => [id, { _id: id, ...o }]));
    }
    async getForeignStateAsync(id) {
        return this.foreign[id] || null;
    }
    async subscribeForeignStatesAsync() {}
    async unsubscribeForeignStatesAsync() {}
    async setForeignStateAsync(id, val, ack) {
        this.writes.push([id, val, ack]);
        this.foreign[id] = { val, ack };
    }
    /** a device or VIS changes a data point */
    change(id, val) {
        this.foreign[id] = { val, ack: true };
        this.emit('stateChange', id, { val, ack: true });
    }
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@iobroker/adapter-core') {
        return { Adapter: FakeAdapter, getAbsoluteInstanceDataDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'logik-')) };
    }
    return origLoad.call(this, request, ...rest);
};

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

test('adapter: example from the editor API, enable it, the solarium logic switches the dimmer', async t => {
    const port = 40000 + Math.floor(Math.random() * 10000);
    const adapter = require('../main.js')({ config: { port, publicHost: '127.0.0.1' } });
    adapter.emit('ready');
    await until(() => adapter.states['info.connection'] && adapter.states['info.connection'].val === true);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    const api = async (p, opts) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/${p}`, opts);
        assert.ok(res.ok, `${p}: ${res.status}`);
        return res.status === 204 ? null : res.json();
    };
    assert.match(adapter.states['info.editorUrl'].val, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok((await api('catalog')).some(b => b.type === 'staircase'));
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /editor\.js/);

    const prog = await api('programs?template=solarium', { method: 'POST', body: '{}' });
    assert.equal(prog.enabled, false); // a template starts off
    assert.equal((await api('programs')).length, 1);
    const found = await api('states?q=t%C3%BCrleser');
    assert.deepEqual(found.map(s => s.id), ['demo.booked']);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const lives = [];
    ws.on('message', d => {
        const m = JSON.parse(d.toString());
        if (m.type === 'live') {
            lives.push(m);
        }
    });
    t.after(() => ws.close());
    await new Promise(r => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'watch', program: prog.id }));

    await api(`programs/${prog.id}`, { method: 'PUT', body: JSON.stringify({ ...prog, enabled: true }) });
    await until(() => adapter.states['info.programs'].val === 1);
    adapter.change('demo.booked', true);
    await until(() => adapter.writes.some(w => w[0] === 'demo.dimmer'));
    assert.deepEqual(adapter.writes.at(-1), ['demo.dimmer', 100, false]);
    adapter.change('demo.solarium', true);
    await until(() => adapter.writes.at(-1)[1] === 20);
    await until(() => lives.some(l => l.blocks.light && l.blocks.light.out.AQ === 20));

    // remanent: "cabin occupied" survives a restart of the logic (saved on unload)
    adapter.saveRetain();
    const retain = JSON.parse(fs.readFileSync(path.join(adapter.dataDir, 'retain.json'), 'utf8'));
    assert.equal(retain[prog.id].occupied.q, 1);

    await api(`programs/${prog.id}`, { method: 'DELETE' });
    assert.equal((await api('programs')).length, 0);
});

test('adapter: access key protects the API', async t => {
    const port = 40000 + Math.floor(Math.random() * 10000);
    const adapter = require('../main.js')({ config: { port, publicHost: '127.0.0.1', accessKey: 'geheim' } });
    adapter.emit('ready');
    await until(() => adapter.states['info.connection'] && adapter.states['info.connection'].val === true);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/programs`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/programs?key=geheim`)).status, 200);
    assert.match(adapter.states['info.editorUrl'].val, /\?key=geheim$/);
});
