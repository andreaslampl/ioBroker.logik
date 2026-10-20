'use strict';

/*
 * Programs and remanent values on disk (instance data directory):
 *   programs.json  [{id, name, enabled, blocks, wires}]
 *   retain.json    {programId: {blockId: state}}
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { definition } = require('./blocks');
const { TEMPLATES } = require('./templates');

class Store {
    /**
     * @param {string} dir instance data directory
     * @param {() => void} onChange called after programs were changed
     */
    constructor(dir, onChange = () => {}) {
        this.dir = dir;
        this.onChange = onChange;
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, 'programs.json');
        this.retainFile = path.join(dir, 'retain.json');
        this.programs = this._read(this.file, []);
    }

    _read(file, fallback) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return fallback;
        }
    }

    _write(file, data) {
        // write to a temp file first: a crash must not leave half a program file
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
        fs.renameSync(tmp, file);
    }

    list() {
        return this.programs;
    }

    /** Keep only what the engine understands; ids are strings without dots. */
    _clean(id, data) {
        const blocks = (Array.isArray(data.blocks) ? data.blocks : [])
            .filter(b => b && typeof b.id === 'string' && definition(b.type))
            .map(b => ({ id: b.id.replace(/[^\w-]/g, '_'), type: b.type, x: Number(b.x) || 0, y: Number(b.y) || 0, params: b.params && typeof b.params === 'object' ? b.params : {} }));
        const ids = new Set(blocks.map(b => b.id));
        const wires = (Array.isArray(data.wires) ? data.wires : [])
            .filter(w => w && w.from && w.to && ids.has(w.from.block) && ids.has(w.to.block))
            .map((w, i) => ({ id: String(w.id || `w${i + 1}`), from: { block: w.from.block, port: String(w.from.port) }, to: { block: w.to.block, port: String(w.to.port) } }));
        return { id, name: String(data.name || 'Programm').slice(0, 80), enabled: data.enabled !== false, blocks, wires };
    }

    async create(data, template) {
        const base = template && TEMPLATES[template] ? TEMPLATES[template]() : { blocks: [], wires: [], enabled: true };
        const id = crypto.randomBytes(4).toString('hex');
        // a template starts switched off: its demo data points must be replaced first
        const prog = this._clean(id, { ...base, name: data.name || base.name, enabled: template ? false : base.enabled });
        this.programs.push(prog);
        this._write(this.file, this.programs);
        this.onChange();
        return prog;
    }

    async save(id, data) {
        const i = this.programs.findIndex(p => p.id === id);
        if (i < 0) {
            throw new Error(`Unknown program ${id}`);
        }
        this.programs[i] = this._clean(id, data);
        this._write(this.file, this.programs);
        this.onChange();
        return this.programs[i];
    }

    async remove(id) {
        this.programs = this.programs.filter(p => p.id !== id);
        this._write(this.file, this.programs);
        this.onChange();
    }

    readRetain() {
        return this._read(this.retainFile, {});
    }

    writeRetain(data) {
        this._write(this.retainFile, data);
    }
}

module.exports = { Store };
