'use strict';

const os = require('node:os');
const utils = require('@iobroker/adapter-core');
const { Engine } = require('./lib/engine');
const { Store } = require('./lib/store');
const { LogicServer } = require('./lib/server');

function localAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal) {
                return a.address;
            }
        }
    }
    return '127.0.0.1';
}

class Logik extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'logik' });
        this.engine = null;
        this.store = null;
        this.server = null;
        this.subscribed = new Set(); // inputs and outputs (outputs for the live view)
        this.inputIds = new Set();
        this.types = new Map(); // stateId -> common.type, for writing outputs
        this.units = new Map(); // stateId -> common.unit, for the live view
        this.liveStates = new Map(); // stateId -> {val, ack, ts} as in ioBroker
        this.stateCache = null;
        this.lastRetain = '';
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        const sys = await this.getForeignObjectAsync('system.config').catch(() => null);
        const c = sys && sys.common;
        const location = c && Number.isFinite(Number(c.latitude)) && c.latitude !== '' ? { latitude: Number(c.latitude), longitude: Number(c.longitude) } : null;
        if (!location) {
            this.log.info('No location in the ioBroker system settings: the astro clock assumes day');
        }
        this.engine = new Engine({ log: this.log, location });
        this.engine.on('write', (id, value, mode) => this.writeOutput(id, value, mode).catch(err => this.log.warn(`Output ${id}: ${err.message}`)));
        this.store = new Store(this.dataDir || utils.getAbsoluteInstanceDataDir(this), () => this.reload().catch(err => this.log.warn(err.message)));
        await this.reload(this.store.readRetain());

        const port = Number(this.config.port) || 8097;
        const key = String(this.config.accessKey || '').trim();
        this.server = new LogicServer({
            store: this.store,
            engine: this.engine,
            accessKey: key,
            log: this.log,
            searchStates: (q, exact) => this.searchStates(q, exact),
            stateInfo: id => this.stateInfo(id),
            objectList: fresh => this.objectList(fresh),
            stateValues: ids => this.stateValues(ids),
        });
        try {
            await this.server.listen(port);
        } catch (err) {
            this.log.error(`Cannot open port ${port}: ${err.message}. Choose another port in the settings.`);
            return;
        }
        const host = String(this.config.publicHost || '').trim() || localAddress();
        const url = `http://${host}:${port}/${key ? `?key=${encodeURIComponent(key)}` : ''}`;
        await this.setState('info.editorUrl', url, true);
        await this.setState('info.connection', true, true);
        this.log.info(`Logic editor at ${url}`);
        // remanent values (memory, counters) are saved every 30 s when they changed
        this.retainTimer = setInterval(() => this.saveRetain(), 30000);
    }

    /** (Re)load the programs into the engine and subscribe to the data points they read. */
    async reload(retained) {
        const programs = this.store.list();
        const keep = retained || this.engine.retained();
        // what the programs will read: subscribe and preset the current values
        const probe = new Engine({ log: { warn() {}, info() {}, debug() {}, error() {} } });
        probe.load(programs.map(p => ({ ...p, enabled: p.enabled !== false })));
        probe.stop();
        const { inputs, outputs } = probe.stateIds();
        const all = new Set([...inputs, ...outputs]);
        for (const id of this.subscribed) {
            if (!all.has(id)) {
                await this.unsubscribeForeignStatesAsync(id);
                this.subscribed.delete(id);
                this.liveStates.delete(id);
            }
        }
        this.inputIds = new Set(inputs);
        for (const id of all) {
            if (!this.subscribed.has(id)) {
                await this.subscribeForeignStatesAsync(id);
                this.subscribed.add(id);
            }
            const st = await this.getForeignStateAsync(id).catch(() => null);
            this.liveStates.set(id, st ? { val: st.val, ack: st.ack, ts: st.ts } : null);
            if (this.inputIds.has(id)) {
                this.engine.preset(id, st ? st.val : 0);
            }
            await this.typeOf(id, outputs.includes(id));
        }
        this.engine.load(programs, keep);
        const active = programs.filter(p => p.enabled !== false).length;
        this.log.info(`${programs.length} program(s), ${active} active, ${inputs.length} input(s), ${outputs.length} output(s)`);
        await this.setState('info.programs', active, true);
        // the editor may have asked for live values while the data points were still being read
        if (this.server) {
            this.server.stateChanged();
        }
    }

    async typeOf(id, isOutput = true) {
        if (!this.types.has(id)) {
            const obj = await this.getForeignObjectAsync(id).catch(() => null);
            if (!obj) {
                this.log.warn(`${isOutput ? 'Output' : 'Input'} data point ${id} does not exist`);
            }
            this.types.set(id, obj && obj.common ? obj.common.type : '');
            this.units.set(id, (obj && obj.common && obj.common.unit) || '');
        }
        return this.types.get(id);
    }

    /** Value of an input/output data point as ioBroker has it, for the live view. */
    stateInfo(id) {
        const st = this.liveStates.get(id);
        return st ? { ...st, unit: this.units.get(id) || '' } : null;
    }

    async writeOutput(id, value, mode) {
        let type = mode === 'bool' ? 'boolean' : mode === 'number' ? 'number' : await this.typeOf(id);
        let val;
        if (type === 'boolean') {
            val = Boolean(value);
        } else if (type === 'string') {
            val = String(value);
        } else {
            val = Number(value);
            type = 'number';
        }
        this.log.debug(`write ${id} = ${val}`);
        await this.setForeignStateAsync(id, val, false);
    }

    onStateChange(id, state) {
        if (!this.subscribed.has(id)) {
            return;
        }
        this.liveStates.set(id, state ? { val: state.val, ack: state.ack, ts: state.ts } : null);
        if (state && this.engine && this.inputIds.has(id)) {
            this.engine.setValue(id, state.val);
        }
        if (this.server) {
            this.server.stateChanged();
        }
    }

    /** All states (plus names of devices/channels/folders) for the editor, cached for 5 min. */
    async objectList(fresh) {
        if (fresh || !this.stateCache || Date.now() - this.stateCache.at > 300000) {
            const name = n => (typeof n === 'object' && n ? n.de || n.en || Object.values(n)[0] || '' : String(n || ''));
            const states = await this.getForeignObjectsAsync('*', 'state');
            const folders = {};
            for (const type of ['device', 'channel', 'folder', 'instance', 'adapter']) {
                const objs = await this.getForeignObjectsAsync('*', type).catch(() => ({}));
                for (const o of Object.values(objs || {})) {
                    if (o && o.type === type && o.common && o.common.name) {
                        folders[o._id] = name(o.common.name);
                    }
                }
            }
            this.stateCache = {
                at: Date.now(),
                folders,
                list: Object.values(states).map(o => {
                    const c = o.common || {};
                    return { id: o._id, name: name(c.name), type: c.type || '', role: c.role || '', unit: c.unit || '', write: c.write !== false };
                }),
            };
        }
        return this.stateCache;
    }

    /** Data point search for the editor. */
    async searchStates(q, exact) {
        const { list } = await this.objectList();
        const text = String(q || '').toLowerCase();
        if (exact) {
            return list.filter(s => s.id === q).slice(0, 1);
        }
        const words = text.split(/\s+/).filter(Boolean);
        return list.filter(s => words.every(w => s.id.toLowerCase().includes(w) || s.name.toLowerCase().includes(w))).slice(0, 50);
    }

    /** Current values for the object browser (at most 300 at once). */
    async stateValues(ids) {
        const out = {};
        await Promise.all(
            ids.slice(0, 300).map(async id => {
                const st = await this.getForeignStateAsync(id).catch(() => null);
                out[id] = st ? st.val : null;
            }),
        );
        return out;
    }

    saveRetain() {
        if (!this.engine || !this.store) {
            return;
        }
        const data = this.engine.retained();
        const json = JSON.stringify(data);
        if (json !== this.lastRetain) {
            this.lastRetain = json;
            try {
                this.store.writeRetain(data);
            } catch (err) {
                this.log.warn(`Cannot save remanent values: ${err.message}`);
            }
        }
    }

    async onUnload(callback) {
        try {
            clearInterval(this.retainTimer);
            this.saveRetain();
            if (this.engine) {
                this.engine.stop();
            }
            if (this.server) {
                await this.server.close();
            }
            await this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Logik(options);
} else {
    new Logik();
}
