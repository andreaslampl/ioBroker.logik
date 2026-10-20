'use strict';

/*
 * Runs the logic programs. A program is a set of blocks connected by wires:
 *
 *   {id, name, enabled, blocks: [{id, type, x, y, params}], wires: [{from: {block, port}, to: {block, port}}]}
 *
 * Event driven: a program is evaluated when one of its input data points changes or when a timer
 * block asked for a wake-up. Blocks are evaluated in signal-flow order; in a feedback loop the
 * block that closes the loop sees the value of the previous evaluation (like a PLC cycle).
 *
 * Events: 'write' (stateId, value, mode) when an output changes, 'evaluated' (programId).
 */

const { EventEmitter } = require('node:events');
const { definition } = require('./blocks');

/** ioBroker value -> number on the wire. */
function toNumber(v) {
    if (typeof v === 'boolean') {
        return v ? 1 : 0;
    }
    if (typeof v === 'number') {
        return Number.isFinite(v) ? v : 0;
    }
    if (typeof v === 'string') {
        const t = v.trim().toLowerCase();
        if (['true', 'on', 'ein', 'an', 'open', 'offen'].includes(t)) {
            return 1;
        }
        if (['false', 'off', 'aus', 'closed', 'zu', ''].includes(t)) {
            return 0;
        }
        const n = Number(t.replace(',', '.'));
        return Number.isFinite(n) ? n : 0;
    }
    return v ? 1 : 0;
}

class Program {
    constructor(def, retained = {}, log) {
        this.id = def.id;
        this.name = def.name || def.id;
        this.enabled = def.enabled !== false;
        this.blocks = new Map();
        for (const raw of def.blocks || []) {
            const d = definition(raw.type);
            if (!d) {
                log.warn(`Program "${this.name}": unknown block type "${raw.type}" ignored`);
                continue;
            }
            const params = {};
            for (const p of d.params) {
                params[p.key] = raw.params && raw.params[p.key] !== undefined ? raw.params[p.key] : p.default;
            }
            const keep = d.retain && params.retain !== false && retained[raw.id];
            this.blocks.set(raw.id, { id: raw.id, def: d, params, s: keep ? { ...retained[raw.id] } : {}, out: {}, first: true });
        }
        // wires by target: "block.port" -> {block, port}
        this.sources = new Map();
        for (const w of def.wires || []) {
            if (this.blocks.has(w.from.block) && this.blocks.has(w.to.block)) {
                this.sources.set(`${w.to.block}.${w.to.port}`, w.from);
            }
        }
        this.order = this._order();
        this.wakeAt = Infinity;
    }

    /** Signal-flow order (Kahn); blocks in feedback loops are appended in their original order. */
    _order() {
        const incoming = new Map([...this.blocks.keys()].map(id => [id, new Set()]));
        for (const [target, from] of this.sources) {
            const id = target.slice(0, target.lastIndexOf('.'));
            if (from.block !== id) {
                incoming.get(id).add(from.block);
            }
        }
        const order = [];
        const done = new Set();
        let progress = true;
        while (progress) {
            progress = false;
            for (const [id, deps] of incoming) {
                if (!done.has(id) && [...deps].every(d => done.has(d))) {
                    order.push(id);
                    done.add(id);
                    progress = true;
                }
            }
        }
        this.hasLoop = false;
        for (const id of this.blocks.keys()) {
            if (!done.has(id)) {
                order.push(id); // part of a loop (or fed by one)
                this.hasLoop = true;
            }
        }
        return order.map(id => this.blocks.get(id));
    }

    inputStates() {
        return [...this.blocks.values()].filter(b => b.def.type === 'input' && b.params.state).map(b => b.params.state);
    }

    outputStates() {
        return [...this.blocks.values()].filter(b => b.def.type === 'output' && b.params.state).map(b => b.params.state);
    }
}

class Engine extends EventEmitter {
    /**
     * @param {object} options
     * @param {object} options.log
     * @param {() => number} [options.now]
     * @param {{latitude: number, longitude: number}|null} [options.location] for the astro clock
     */
    constructor({ log, now = () => Date.now(), location = null }) {
        super();
        this.log = log;
        this.now = now;
        this.location = location;
        this.programs = new Map();
        this.values = new Map(); // stateId -> number
        this.timer = null;
        this.errors = new Set();
    }

    /** (Re)load all programs; `retained` = {programId: {blockId: state}} from the last run. */
    load(programs, retained = {}) {
        this.stop();
        this.programs.clear();
        for (const def of programs) {
            const p = new Program(def, retained[def.id] || {}, this.log);
            this.programs.set(p.id, p);
        }
        for (const p of this.programs.values()) {
            if (p.enabled) {
                this._evaluate(p);
            }
        }
        this._schedule();
    }

    stop() {
        clearTimeout(this.timer);
        this.timer = null;
    }

    /** Data points the programs read (inputs) and write (outputs). */
    stateIds() {
        const inputs = new Set();
        const outputs = new Set();
        for (const p of this.programs.values()) {
            if (p.enabled) {
                p.inputStates().forEach(id => inputs.add(id));
                p.outputStates().forEach(id => outputs.add(id));
            }
        }
        return { inputs: [...inputs], outputs: [...outputs] };
    }

    /** Initial value of a data point, without evaluating (before load). */
    preset(stateId, value) {
        this.values.set(stateId, toNumber(value));
    }

    /** A data point changed: evaluate the programs that read it. */
    setValue(stateId, value) {
        const v = toNumber(value);
        const changed = this.values.get(stateId) !== v;
        this.values.set(stateId, v);
        if (!changed) {
            return;
        }
        for (const p of this.programs.values()) {
            if (p.enabled && p.inputStates().includes(stateId)) {
                this._evaluate(p);
            }
        }
        this._schedule();
    }

    _evaluate(p) {
        const now = this.now();
        let wakeAt = Infinity;
        const wake = at => {
            wakeAt = Math.min(wakeAt, at);
        };
        // With feedback loops one pass may leave a result one step behind: repeat until stable.
        for (let pass = 0; pass < (p.hasLoop ? 10 : 1); pass++) {
            if (!this._pass(p, now, wake) && pass > 0) {
                break;
            }
        }
        // write outputs once, with the settled values
        for (const block of p.order) {
            if (block.def.type === 'output' && block.params.state) {
                const v = block.out.I;
                // Outputs are written when the result changes - not at start, so a light that was
                // switched by hand is not overridden just because the adapter restarted.
                if (!block.started) {
                    block.started = true;
                } else if (v !== block.written) {
                    this.emit('write', block.params.state, v, block.params.mode);
                }
                block.written = v;
            }
        }
        p.wakeAt = wakeAt;
        this.emit('evaluated', p.id);
    }

    /** One pass over all blocks; returns true if any output changed. */
    _pass(p, now, wake) {
        let changed = false;
        for (const block of p.order) {
            const d = block.def;
            const inputs = {};
            for (const inp of d.inputs) {
                const src = p.sources.get(`${block.id}.${inp.name}`);
                if (src) {
                    const from = p.blocks.get(src.block);
                    const v = from.out[src.port];
                    inputs[inp.name] = v === undefined ? 0 : v;
                } else {
                    inputs[inp.name] = inp.open;
                }
            }
            const ctx = {
                in: inputs,
                p: block.params,
                s: block.s,
                now,
                first: block.first,
                prev: block.out,
                location: this.location,
                value: d.type === 'input' ? this.values.get(block.params.state) : undefined,
                wake,
            };
            let out;
            try {
                out = d.evaluate(ctx) || {};
            } catch (err) {
                const key = `${p.id}.${block.id}`;
                if (!this.errors.has(key)) {
                    this.errors.add(key);
                    this.log.warn(`Program "${p.name}", block ${d.label} (${block.id}): ${err.message}`);
                }
                out = block.out;
            }
            if (d.type === 'output') {
                out = { I: inputs.I };
            }
            if (JSON.stringify(out) !== JSON.stringify(block.out)) {
                changed = true;
            }
            block.out = out;
            block.first = false;
        }
        return changed;
    }

    _schedule() {
        clearTimeout(this.timer);
        let next = Infinity;
        for (const p of this.programs.values()) {
            if (p.enabled) {
                next = Math.min(next, p.wakeAt);
            }
        }
        if (next === Infinity) {
            return;
        }
        const delay = Math.min(Math.max(0, next - this.now()), 0x7fffffff);
        this.timer = setTimeout(() => this._tick(), delay);
    }

    _tick() {
        const now = this.now();
        for (const p of this.programs.values()) {
            if (p.enabled && p.wakeAt <= now) {
                this._evaluate(p);
            }
        }
        this._schedule();
    }

    /** States of remanent blocks (memory, counters) to keep across restarts. */
    retained() {
        const out = {};
        for (const p of this.programs.values()) {
            for (const b of p.blocks.values()) {
                if (b.def.retain && b.params.retain !== false) {
                    out[p.id] = out[p.id] || {};
                    out[p.id][b.id] = b.s;
                }
            }
        }
        return out;
    }

    /** Current values for the live view: outputs of every block. */
    snapshot(programId) {
        const p = this.programs.get(programId);
        if (!p) {
            return null;
        }
        const blocks = {};
        for (const b of p.blocks.values()) {
            const extra = {};
            if (b.def.type === 'input') {
                extra.value = this.values.get(b.params.state);
            }
            if ((b.def.type === 'input' || b.def.type === 'output') && b.params.state) {
                extra.state = b.params.state;
            }
            blocks[b.id] = { out: b.out, ...extra, ...(b.s.until && b.s.until > this.now() ? { remaining: Math.ceil((b.s.until - this.now()) / 1000) } : {}) };
        }
        return { program: p.id, enabled: p.enabled, blocks };
    }
}

module.exports = { Engine, Program, toNumber };
