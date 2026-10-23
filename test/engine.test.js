'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../lib/engine');
const { parseSchedule, scheduleState } = require('../lib/blocks');
const { sunTimes } = require('../lib/sun');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Engine with a fake clock; `advance(s)` moves time and runs due timers. */
function setup(program, options = {}) {
    let now = options.start || new Date(2026, 9, 21, 12, 0, 0).getTime();
    const engine = new Engine({ log: quiet, now: () => now, location: options.location || null });
    const writes = [];
    engine.on('write', (id, v) => writes.push([id, v]));
    for (const [id, v] of Object.entries(options.values || {})) {
        engine.preset(id, v);
    }
    engine.load([{ id: 'p', name: 'Test', ...program }], options.retained);
    const set = (id, v) => engine.setValue(id, v);
    const advance = s => {
        now += s * 1000;
        engine._tick();
    };
    const out = (block, port = 'Q') => engine.programs.get('p').blocks.get(block).out[port];
    const last = id => [...writes].reverse().find(w => w[0] === id);
    return { engine, writes, set, advance, out, last, stop: () => engine.stop() };
}

const io = (id, state) => ({ id, type: 'input', params: { state } });
const outBlock = (id, state, mode) => ({ id, type: 'output', params: { state, mode } });
const w = (from, to, fromPort = 'Q', toPort = 'I') => ({ from: { block: from, port: fromPort }, to: { block: to, port: toPort } });

test('AND / OR / NOT with open inputs like the LOGO!', t => {
    const e = setup({
        blocks: [io('a', 'x.a'), io('b', 'x.b'), { id: 'and', type: 'and' }, { id: 'or', type: 'or' }, { id: 'not', type: 'not' }, outBlock('q', 'x.q')],
        wires: [w('a', 'and', 'Q', 'I1'), w('b', 'and', 'Q', 'I2'), w('a', 'or', 'Q', 'I1'), w('b', 'or', 'Q', 'I2'), w('and', 'not'), w('and', 'q')],
    });
    t.after(e.stop);
    assert.equal(e.out('and'), 0);
    assert.equal(e.out('not'), 1);
    e.set('x.a', true);
    assert.equal(e.out('or'), 1);
    assert.equal(e.out('and'), 0);
    e.set('x.b', 'true');
    assert.equal(e.out('and'), 1);
    assert.deepEqual(e.writes, [['x.q', 1]]); // nothing written at start, only on change
});

test('timers: on-delay, off-delay, staircase, clock', t => {
    const e = setup({
        blocks: [
            io('a', 'x.a'),
            { id: 'on', type: 'ondelay', params: { T: 5 } },
            { id: 'off', type: 'offdelay', params: { T: 10 } },
            { id: 'st', type: 'staircase', params: { T: 180 } },
            { id: 'clk', type: 'clock', params: { TH: 1, TL: 2 } },
        ],
        wires: [w('a', 'on', 'Q', 'Trg'), w('a', 'off', 'Q', 'Trg'), w('a', 'st', 'Q', 'Trg')],
    });
    t.after(e.stop);
    e.set('x.a', 1);
    assert.equal(e.out('on'), 0);
    assert.equal(e.out('off'), 1);
    e.advance(5);
    assert.equal(e.out('on'), 1);
    e.set('x.a', 0);
    assert.equal(e.out('on'), 0);
    assert.equal(e.out('off'), 1);
    e.advance(9);
    assert.equal(e.out('off'), 1);
    e.advance(1);
    assert.equal(e.out('off'), 0);
    assert.equal(e.out('st'), 1);
    e.advance(170);
    assert.equal(e.out('st'), 0);
    // clock: 1 s on, 2 s off
    const seq = [];
    for (let i = 0; i < 6; i++) {
        seq.push(e.out('clk'));
        e.advance(1);
    }
    assert.ok(seq.includes(0) && seq.includes(1));
});

test('memory: RS (reset wins), toggle relay, counter, edges', t => {
    const e = setup({
        blocks: [io('s', 'x.s'), io('r', 'x.r'), { id: 'rs', type: 'rs' }, { id: 'tg', type: 'toggle' }, { id: 'cnt', type: 'counter', params: { on: 3, off: 3 } }, { id: 'up', type: 'rise' }],
        wires: [w('s', 'rs', 'Q', 'S'), w('r', 'rs', 'Q', 'R'), w('s', 'tg', 'Q', 'Trg'), w('s', 'cnt', 'Q', 'Cnt'), w('s', 'up')],
    });
    t.after(e.stop);
    e.set('x.s', 1);
    assert.equal(e.out('rs'), 1);
    assert.equal(e.out('tg'), 1);
    assert.equal(e.out('up'), 1); // one-cycle pulse ...
    e.advance(0);
    assert.equal(e.out('up'), 0); // ... dropped right after
    e.set('x.r', 1);
    assert.equal(e.out('rs'), 0); // S and R: reset wins
    e.set('x.s', 0);
    e.set('x.s', 1);
    assert.equal(e.out('tg'), 0);
    e.set('x.s', 0);
    e.set('x.s', 1);
    assert.equal(e.out('cnt', 'AQ'), 3);
    assert.equal(e.out('cnt'), 1);
    // remanent: RS/counter state survives a reload
    const kept = e.engine.retained();
    assert.equal(kept.p.cnt.count, 3);
});

test('analog: threshold with hysteresis, compare, multiplexer, scaling, math', t => {
    const e = setup({
        blocks: [
            io('t', 'x.temp'),
            { id: 'th', type: 'threshold', params: { on: 25, off: 23 } },
            { id: 'k', type: 'constant', params: { value: 20 } },
            { id: 'cmp', type: 'compare', params: { op: '>' } },
            { id: 'amp', type: 'amp', params: { gain: 2, offset: 1 } },
            { id: 'm', type: 'math', params: { op: 'max' } },
        ],
        wires: [w('t', 'th', 'Q', 'Ax'), w('t', 'cmp', 'Q', 'A'), w('k', 'cmp', 'Q', 'B'), w('t', 'amp', 'Q', 'Ax'), w('t', 'm', 'Q', 'A'), w('k', 'm', 'Q', 'B')],
    });
    t.after(e.stop);
    e.set('x.temp', '24,5');
    assert.equal(e.out('th'), 0);
    e.set('x.temp', 25);
    assert.equal(e.out('th'), 1);
    e.set('x.temp', 23.5);
    assert.equal(e.out('th'), 1); // hysteresis
    e.set('x.temp', 22.9);
    assert.equal(e.out('th'), 0);
    assert.equal(e.out('cmp'), 1);
    assert.equal(e.out('amp', 'AQ'), 46.8);
    assert.equal(e.out('m', 'AQ'), 22.9);
});

test('weekly timer and schedules over midnight', () => {
    const entries = parseSchedule('Mo-Fr 06:30-22:00; Sa,So 08:00-23:00; täglich 23:30-00:30');
    assert.equal(entries.length, 3);
    const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime(); // 19.10.2026 = Monday
    assert.equal(scheduleState(entries, at(19, 6, 29)).on, false);
    assert.equal(scheduleState(entries, at(19, 6, 30)).on, true);
    assert.equal(scheduleState(entries, at(24, 7, 0)).on, false); // Saturday
    assert.equal(scheduleState(entries, at(24, 8, 0)).on, true);
    assert.equal(scheduleState(entries, at(25, 0, 15)).on, true); // after midnight
});

test('sun times for Vienna are plausible', () => {
    const { rise, set } = sunTimes(new Date(2026, 5, 21, 12).getTime(), 48.21, 16.37);
    const h = ms => new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() / 60;
    assert.ok(h(rise) > 2.6 && h(rise) < 3.2, `rise ${h(rise)} UTC`); // ~04:53 local (CEST)
    assert.ok(h(set) > 18.8 && h(set) < 19.3, `set ${h(set)} UTC`); // ~21:00 local
});

test('example: solarium cabin (booking -> light, solarium -> dimmed, leaving -> off)', t => {
    const e = setup(require('../lib/templates').solarium(), { values: { 'demo.dimmer': 0 } });
    t.after(e.stop);
    const light = () => (e.last('demo.dimmer') || [])[1];
    e.set('demo.booked', true); // card reader: booked
    assert.equal(light(), 100);
    e.set('demo.booked', false); // reader pulse over: light stays
    assert.equal(light(), 100);
    e.set('demo.solarium', true);
    assert.equal(light(), 20); // tanning: dimmed
    e.set('demo.solarium', false);
    assert.equal(light(), 100);
    e.set('demo.door', true); // door opened without leaving motion: light stays
    assert.equal(light(), 100);
    e.set('demo.door', false);
    e.set('demo.exitMotion', true); // guest walks to the exit ...
    e.set('demo.exitMotion', false);
    e.set('demo.door', true); // ... and opens the door: off
    assert.equal(light(), 0);
    e.set('demo.door', false);
    e.set('demo.booked', true); // next guest
    assert.equal(light(), 100);
});

test('message block: sends when the input becomes 1 (window open longer than 15 min), not at start', t => {
    const e = setup(
        {
            blocks: [io('win', 'knx.0.Fenster'), { id: 'dly', type: 'ondelay', params: { T: 900 } }, { id: 'msg', type: 'notify', params: { title: 'Fenster', text: 'Bad seit 15 min offen' } }],
            wires: [w('win', 'dly', 'Q', 'Trg'), w('dly', 'msg')],
        },
        { values: { 'knx.0.Fenster': 1 } },
    );
    t.after(e.stop);
    const sent = [];
    e.engine.on('notify', (target, msg) => sent.push([target, msg]));
    // already open at start: the delay runs, a message comes after 15 min (that is a change after the start)
    e.set('knx.0.Fenster', 0);
    e.set('knx.0.Fenster', 1);
    e.advance(600);
    assert.equal(sent.length, 0);
    e.advance(301);
    assert.deepEqual(sent, [['smartview.0.push.message', { title: 'Fenster', text: 'Bad seit 15 min offen' }]]);
    e.advance(600);
    assert.equal(sent.length, 1, 'once, not again while it stays open');
});
