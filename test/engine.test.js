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
    const engine = new Engine({ log: quiet, now: () => now, location: options.location || null, random: options.random });
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

/** repeatable "random" numbers (linear congruential generator) */
const seeded = seed => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};

for (const seed of [1, 7, 42, 1234, 99999]) test(`flicker (seed ${seed}): random times within the limits, never faster than the shortest switching time, stops after T`, t => {
    const e = setup({
        blocks: [io('m', 'x.motion'), { id: 'fl', type: 'flicker', params: { T: 20, onMin: 0.3, onMax: 1.2, offMin: 0.3, offMax: 2.5, min: 0.3 } }, outBlock('l', 'x.light', 'bool')],
        wires: [w('m', 'fl', 'Q', 'En'), w('fl', 'l')],
    }, { random: seeded(seed) });
    t.after(e.stop);
    e.set('x.motion', true);
    assert.equal(e.out('fl'), 1, 'starts with a flash');
    const changes = [];
    let last = 1;
    for (let i = 0; i < 250; i++) {
        e.advance(0.1); // 25 s in 100 ms steps
        if (e.out('fl') !== last) {
            last = e.out('fl');
            changes.push(i);
        }
    }
    assert.ok(changes.length >= 6, `flickers (${changes.length} changes)`);
    const gaps = changes.slice(1).map((c, i) => c - changes[i]);
    assert.ok(Math.min(...gaps) >= 3, 'at least 0.3 s between two switchings');
    assert.equal(e.out('fl'), 0, 'off after 20 s although the motion detector is still on');
    assert.equal(e.last('x.light')[1], 0, 'light off at the end (0 = false for a bool output)');
    // a short movement (detector drops after 1 s) still gives the whole 20 s
    e.set('x.motion', false);
    e.set('x.motion', true);
    assert.equal(e.out('fl'), 1);
    e.advance(1);
    e.set('x.motion', false);
    let seen = 0;
    for (let i = 0; i < 150; i++) {
        e.advance(0.1);
        seen += e.out('fl');
    }
    assert.ok(seen > 0, 'still flickering after the detector dropped');
});

test('flicker: R stops at once, T = 0 runs as long as En is on', t => {
    const e = setup({
        blocks: [io('m', 'x.m'), io('r', 'x.r'), { id: 'fl', type: 'flicker', params: { T: 0, onMin: 0.3, onMax: 0.3, offMin: 0.3, offMax: 0.3, min: 0.3 } }],
        wires: [w('m', 'fl', 'Q', 'En'), w('r', 'fl', 'Q', 'R')],
    }, { random: () => 0.5 });
    t.after(e.stop);
    e.set('x.m', true);
    e.advance(60);
    assert.ok([0, 1].includes(e.out('fl')));
    e.set('x.m', false);
    e.advance(1);
    assert.equal(e.out('fl'), 0, 'T = 0: stops with En');
    e.set('x.m', true);
    assert.equal(e.out('fl'), 1);
    e.advance(0.5);
    e.set('x.r', true);
    assert.equal(e.out('fl'), 0, 'R stops at once');
});

test('room controller (PI): heats when too cold, settles, window / release off, modes, anti-windup, cyclic sending', t => {
    const e = setup({
        blocks: [io('ist', 'x.ist'), io('soll', 'x.soll'), io('win', 'x.win'), io('en', 'x.en'), io('m', 'x.mode'),
            { id: 'pi', type: 'pi', params: { Xp: 5, Tn: 150, standby: 2, night: 4, frost: 7, every: 60 } }, outBlock('v', 'x.valve', 'number')],
        wires: [w('ist', 'pi', 'Q', 'Ist'), w('soll', 'pi', 'Q', 'Soll'), w('win', 'pi', 'Q', 'Win'), w('en', 'pi', 'Q', 'En'), w('m', 'pi', 'Q', 'M'), w('pi', 'v', 'Y', 'I')],
    }, { values: { 'x.ist': 20, 'x.soll': 21, 'x.en': 1, 'x.mode': 1 } });
    t.after(e.stop);
    e.engine.programs.get('p').blocks.get('v').params.cyclic = 10;
    e.advance(60);
    assert.equal(e.out('pi', 'Y'), 20 + Math.round(20 / 150 * 1), '1 K too cold: P = 20 % plus a little I');
    assert.equal(e.out('pi', 'S'), 21);
    // stays too cold for 2 h: the I part grows
    for (let i = 0; i < 120; i++) e.advance(60);
    assert.ok(e.out('pi', 'Y') > 30, `integral grows (${e.out('pi', 'Y')})`);
    // warm enough: P goes to 0, I keeps a part (like a real controller)
    e.set('x.ist', 21);
    e.advance(60);
    const settled = e.out('pi', 'Y');
    assert.ok(settled > 0 && settled < 30, `holds a base load (${settled})`);
    // too warm: goes down, never below 0
    e.set('x.ist', 25);
    for (let i = 0; i < 30; i++) e.advance(60);
    assert.equal(e.out('pi', 'Y'), 0);
    // window open -> 0, release off -> 0
    e.set('x.ist', 18);
    e.advance(60);
    assert.ok(e.out('pi', 'Y') > 0);
    e.set('x.win', 1);
    assert.equal(e.out('pi', 'Y'), 0);
    e.set('x.win', 0);
    e.set('x.en', 0);
    assert.equal(e.out('pi', 'Y'), 0);
    e.set('x.en', 1);
    // night mode lowers the set point by 4 K, frost protection 7 °C
    e.set('x.mode', 3);
    assert.equal(e.out('pi', 'S'), 17);
    e.set('x.mode', 4);
    assert.equal(e.out('pi', 'S'), 7);
    // anti-windup: very cold for hours stays at 100 % and comes down quickly afterwards
    e.set('x.mode', 1);
    e.set('x.ist', 10);
    for (let i = 0; i < 300; i++) e.advance(60);
    assert.equal(e.out('pi', 'Y'), 100);
    e.set('x.ist', 21.5);
    e.advance(60);
    assert.ok(e.out('pi', 'Y') < 100, 'not stuck at 100 % after a long cold phase');
    // the valve output is sent again after 10 min although nothing changed
    const n = e.writes.filter(x => x[0] === 'x.valve').length;
    e.set('x.ist', 30); // -> 0 % and stays
    for (let i = 0; i < 35; i++) e.advance(60);
    const valveWrites = e.writes.filter(x => x[0] === 'x.valve').slice(n);
    assert.ok(valveWrites.length >= 3, `cyclic every 10 min (${valveWrites.length} writes in 35 min)`);
    assert.deepEqual(valveWrites.slice(-2).map(x => x[1]), [0, 0], 'the same value again');
});

test('room controller (PI): no valid temperature keeps the last position', t => {
    const e = setup({
        blocks: [io('ist', 'x.ist'), io('soll', 'x.soll'), { id: 'pi', type: 'pi', params: { Xp: 5, Tn: 150, every: 60 } }],
        wires: [w('ist', 'pi', 'Q', 'Ist'), w('soll', 'pi', 'Q', 'Soll')],
    }, { values: { 'x.ist': 19, 'x.soll': 21 } });
    t.after(e.stop);
    e.advance(60);
    const y = e.out('pi', 'Y');
    assert.ok(y > 0);
    e.set('x.ist', 0); // sensor lost (0 = no value)
    e.advance(120);
    assert.equal(e.out('pi', 'Y'), y);
});

test('room controller (PI): floor cooling with the same valves - dead band, switch over, humidity lock', t => {
    const e = setup({
        blocks: [io('ist', 'x.ist'), io('soll', 'x.soll'), { id: 'hc', type: 'input', params: { state: 'x.heatcool', invert: true } }, io('rh', 'x.rh'),
            { id: 'pi', type: 'pi', params: { Xp: 5, Tn: 240, coolOffset: 2, rhMax: 65, every: 60 } }],
        // KNX DPT 1.100: 1 = heating, 0 = cooling -> inverted to the Cool input
        wires: [w('ist', 'pi', 'Q', 'Ist'), w('soll', 'pi', 'Q', 'Soll'), w('hc', 'pi', 'Q', 'Cool'), w('rh', 'pi', 'Q', 'RH')],
    }, { values: { 'x.ist': 23, 'x.soll': 22, 'x.heatcool': 1, 'x.rh': 50 } });
    t.after(e.stop);
    e.advance(60);
    assert.equal(e.out('pi', 'Y'), 0, 'heating: 23 °C is warm enough');
    e.set('x.heatcool', 0); // summer: cooling
    e.advance(60);
    assert.equal(e.out('pi', 'S'), 24, 'cooling set point = 22 + 2');
    assert.equal(e.out('pi', 'Y'), 0, 'in the dead band: no cooling');
    e.set('x.ist', 25);
    e.advance(60);
    assert.ok(e.out('pi', 'Y') >= 20, `1 K too warm: cools (${e.out('pi', 'Y')})`);
    e.set('x.rh', 70);
    e.advance(60);
    assert.equal(e.out('pi', 'Y'), 0, 'too humid: cooling locked (condensation)');
    e.set('x.rh', 55);
    e.advance(60);
    assert.ok(e.out('pi', 'Y') > 0);
    // back to heating: the cooling I part does not carry over
    e.set('x.heatcool', 1);
    e.set('x.ist', 22);
    e.advance(60);
    assert.equal(e.out('pi', 'Y'), 0);
});
