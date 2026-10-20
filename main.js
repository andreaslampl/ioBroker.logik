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
        this.subscribed = new Set();
        this.types = new Map(); // stateId -> common.type, for writing outputs
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
        for (const id of this.subscribed) {
            if (!inputs.includes(id)) {
                await this.unsubscribeForeignStatesAsync(id);
                this.subscribed.delete(id);
            }
        }
        for (const id of inputs) {
            if (!this.subscribed.has(id)) {
                await this.subscribeForeignStatesAsync(id);
                this.subscribed.add(id);
            }
            const st = await this.getForeignStateAsync(id).catch(() => null);
            this.engine.preset(id, st ? st.val : 0);
        }
        for (const id of outputs) {
            await this.typeOf(id);
        }
        this.engine.load(programs, keep);
        const active = programs.filter(p => p.enabled !== false).length;
        this.log.info(`${programs.length} program(s), ${active} active, ${inputs.length} input(s), ${outputs.length} output(s)`);
        await this.setState('info.programs', active, true);
    }

    async typeOf(id) {
        if (!this.types.has(id)) {
            const obj = await this.getForeignObjectAsync(id).catch(() => null);
            if (!obj) {
                this.log.warn(`Output data point ${id} does not exist`);
            }
            this.types.set(id, obj && obj.common ? obj.common.type : '');
        }
        return this.types.get(id);
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
        if (state && this.engine && this.subscribed.has(id)) {
            this.engine.setValue(id, state.val);
        }
    }

    /** Data point search for the editor. */
    async searchStates(q, exact) {
        if (!this.stateCache || Date.now() - this.stateCache.at > 300000) {
            const objs = await this.getForeignObjectsAsync('*', 'state');
            const lang = 'de';
            const name = n => (typeof n === 'object' && n ? n[lang] || n.en || Object.values(n)[0] || '' : String(n || ''));
            this.stateCache = {
                at: Date.now(),
                list: Object.values(objs).map(o => ({ id: o._id, name: name(o.common && o.common.name), type: o.common ? o.common.type : '' })),
            };
        }
        const text = String(q || '').toLowerCase();
        if (exact) {
            return this.stateCache.list.filter(s => s.id === q).slice(0, 1);
        }
        const words = text.split(/\s+/).filter(Boolean);
        return this.stateCache.list.filter(s => words.every(w => s.id.toLowerCase().includes(w) || s.name.toLowerCase().includes(w))).slice(0, 50);
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
