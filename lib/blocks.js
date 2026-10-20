'use strict';

/*
 * Function blocks in the style of a small PLC (LOGO!-like). Every value on a wire is a number;
 * digital signals are 0/1. A block gets its input values, its parameters and its own state and
 * returns its outputs; timers ask for a wake-up time (`ctx.wake(at)`), the engine evaluates the
 * program again then.
 *
 * Definition fields:
 *   group, label, symbol   palette and drawing
 *   inputs                 [name] or [{name, open}] - `open` = value of an unconnected input
 *   outputs                [name]
 *   params                 [{key, label, type: number|time|text|select|state|bool, default, options, unit, help}]
 *   retain                 state survives a restart (memory, counters)
 *   evaluate(ctx)          -> {output: value}
 *
 * ctx: {in, p, s, now, wake(at), first, prev}  (prev = last outputs)
 */

const { sunTimes } = require('./sun');

const b = v => (v ? 1 : 0);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ms = seconds => Math.max(0, num(seconds)) * 1000;

/** Rising edge of `value` since the last evaluation (kept in s[key]). */
function rising(s, key, value) {
    const last = s[key] || 0;
    s[key] = b(value);
    return !last && value;
}

function falling(s, key, value) {
    const last = s[key] || 0;
    s[key] = b(value);
    return last && !value;
}

/** A pulse that lasts one evaluation: on, and ask to be evaluated again right away to drop it. */
function pulse(ctx, on) {
    if (on) {
        ctx.wake(ctx.now);
    }
    return b(on);
}

const WEEKDAYS = { mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6, so: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };

/**
 * "Mo-Fr 06:30-22:00; Sa,So 08:00-23:00" -> [{days: Set, on: minutes, off: minutes}]
 * Times past midnight ("22:00-06:00") are allowed.
 */
function parseSchedule(text) {
    const out = [];
    for (const part of String(text || '').split(/[;\n]+/)) {
        const m = /^\s*([A-Za-zäöü,\s-]*?)\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
        if (!m) {
            continue;
        }
        const days = new Set();
        const spec = m[1].toLowerCase().replace(/\s+/g, '');
        if (!spec || spec === 'täglich' || spec === 'mo-so') {
            [0, 1, 2, 3, 4, 5, 6].forEach(d => days.add(d));
        } else {
            for (const item of spec.split(',')) {
                const [a, z] = item.split('-').map(x => WEEKDAYS[x]);
                if (a === undefined) {
                    continue;
                }
                if (z === undefined) {
                    days.add(a);
                    continue;
                }
                // Mo-Fr, Fr-Mo (over the weekend) ...
                for (let d = a, i = 0; i < 7; d = (d + 1) % 7, i++) {
                    days.add(d);
                    if (d === z) {
                        break;
                    }
                }
            }
        }
        out.push({ days, on: Number(m[2]) * 60 + Number(m[3]), off: Number(m[4]) * 60 + Number(m[5]) });
    }
    return out;
}

/** Is `date` inside one of the schedule entries? Also returns when that changes next (ms). */
function scheduleState(entries, now) {
    const d = new Date(now);
    const minute = d.getHours() * 60 + d.getMinutes();
    const day = d.getDay();
    const yesterday = (day + 6) % 7;
    let on = false;
    for (const e of entries) {
        if (e.on <= e.off) {
            if (e.days.has(day) && minute >= e.on && minute < e.off) {
                on = true;
            }
        } else if ((e.days.has(day) && minute >= e.on) || (e.days.has(yesterday) && minute < e.off)) {
            on = true; // over midnight, started the day before
        }
    }
    // next full minute: schedules switch on minute boundaries
    const next = new Date(now);
    next.setSeconds(0, 0);
    return { on, next: next.getTime() + 60000 };
}

const TIME_HELP = 'Sekunden, Kommazahlen erlaubt (z. B. 0.5 oder 180)';

const BLOCKS = {
    // ---------------- inputs / outputs ----------------
    input: {
        group: 'Ein-/Ausgänge',
        label: 'Eingang',
        symbol: 'I',
        inputs: [],
        outputs: ['Q'],
        params: [
            { key: 'state', label: 'Datenpunkt', type: 'state', default: '' },
            { key: 'invert', label: 'Invertieren', type: 'bool', default: false },
        ],
        evaluate: ctx => {
            const v = ctx.value === undefined ? 0 : ctx.value;
            return { Q: ctx.p.invert ? b(!v) : v };
        },
    },
    output: {
        group: 'Ein-/Ausgänge',
        label: 'Ausgang',
        symbol: 'Q',
        inputs: [{ name: 'I', open: 0 }],
        outputs: [],
        params: [
            { key: 'state', label: 'Datenpunkt', type: 'state', default: '' },
            {
                key: 'mode',
                label: 'Schreiben als',
                type: 'select',
                default: 'auto',
                options: [
                    ['auto', 'automatisch (wie der Datenpunkt)'],
                    ['bool', 'Ein/Aus (true/false)'],
                    ['number', 'Zahl (z. B. Dimmwert)'],
                ],
            },
        ],
        evaluate: () => ({}),
    },
    constant: {
        group: 'Ein-/Ausgänge',
        label: 'Konstante',
        symbol: 'K',
        inputs: [],
        outputs: ['Q'],
        params: [{ key: 'value', label: 'Wert', type: 'number', default: 1 }],
        evaluate: ctx => ({ Q: num(ctx.p.value) }),
    },
    comment: {
        group: 'Ein-/Ausgänge',
        label: 'Notiz',
        symbol: '✎',
        inputs: [],
        outputs: [],
        params: [{ key: 'text', label: 'Text', type: 'text', default: 'Notiz' }],
        evaluate: () => ({}),
    },

    // ---------------- basic functions ----------------
    and: {
        group: 'Grundfunktionen',
        label: 'UND',
        symbol: '&',
        inputs: [1, 2, 3, 4].map(i => ({ name: `I${i}`, open: 1 })),
        outputs: ['Q'],
        evaluate: ctx => ({ Q: b(['I1', 'I2', 'I3', 'I4'].every(k => ctx.in[k])) }),
    },
    nand: {
        group: 'Grundfunktionen',
        label: 'NAND',
        symbol: '&̄',
        inputs: [1, 2, 3, 4].map(i => ({ name: `I${i}`, open: 1 })),
        outputs: ['Q'],
        evaluate: ctx => ({ Q: b(!['I1', 'I2', 'I3', 'I4'].every(k => ctx.in[k])) }),
    },
    or: {
        group: 'Grundfunktionen',
        label: 'ODER',
        symbol: '≥1',
        inputs: [1, 2, 3, 4].map(i => ({ name: `I${i}`, open: 0 })),
        outputs: ['Q'],
        evaluate: ctx => ({ Q: b(['I1', 'I2', 'I3', 'I4'].some(k => ctx.in[k])) }),
    },
    nor: {
        group: 'Grundfunktionen',
        label: 'NOR',
        symbol: '≥1̄',
        inputs: [1, 2, 3, 4].map(i => ({ name: `I${i}`, open: 0 })),
        outputs: ['Q'],
        evaluate: ctx => ({ Q: b(!['I1', 'I2', 'I3', 'I4'].some(k => ctx.in[k])) }),
    },
    xor: {
        group: 'Grundfunktionen',
        label: 'XOR',
        symbol: '=1',
        inputs: [
            { name: 'I1', open: 0 },
            { name: 'I2', open: 0 },
        ],
        outputs: ['Q'],
        evaluate: ctx => ({ Q: b(Boolean(ctx.in.I1) !== Boolean(ctx.in.I2)) }),
    },
    not: {
        group: 'Grundfunktionen',
        label: 'NICHT',
        symbol: '1̄',
        inputs: [{ name: 'I', open: 0 }],
        outputs: ['Q'],
        evaluate: ctx => ({ Q: b(!ctx.in.I) }),
    },
    rise: {
        group: 'Grundfunktionen',
        label: 'Flanke steigend',
        symbol: '↑',
        inputs: [{ name: 'I', open: 0 }],
        outputs: ['Q'],
        evaluate: ctx => ({ Q: pulse(ctx, rising(ctx.s, 'last', ctx.in.I)) }),
    },
    fall: {
        group: 'Grundfunktionen',
        label: 'Flanke fallend',
        symbol: '↓',
        inputs: [{ name: 'I', open: 0 }],
        outputs: ['Q'],
        evaluate: ctx => ({ Q: pulse(ctx, falling(ctx.s, 'last', ctx.in.I)) }),
    },

    // ---------------- timers ----------------
    ondelay: {
        group: 'Zeiten',
        label: 'Einschaltverzögerung',
        symbol: '⊓→',
        inputs: [{ name: 'Trg', open: 0 }],
        outputs: ['Q'],
        params: [{ key: 'T', label: 'Verzögerung', type: 'time', default: 5, unit: 's', help: TIME_HELP }],
        evaluate: ctx => {
            const { s } = ctx;
            if (!ctx.in.Trg) {
                s.since = null;
                return { Q: 0 };
            }
            s.since = s.since || ctx.now;
            const at = s.since + ms(ctx.p.T);
            if (ctx.now >= at) {
                return { Q: 1 };
            }
            ctx.wake(at);
            return { Q: 0 };
        },
    },
    offdelay: {
        group: 'Zeiten',
        label: 'Ausschaltverzögerung',
        symbol: '→⊓',
        inputs: [
            { name: 'Trg', open: 0 },
            { name: 'R', open: 0 },
        ],
        outputs: ['Q'],
        params: [{ key: 'T', label: 'Nachlaufzeit', type: 'time', default: 60, unit: 's', help: TIME_HELP }],
        evaluate: ctx => {
            const { s } = ctx;
            if (ctx.in.R) {
                s.until = null;
                s.on = 0;
                return { Q: 0 };
            }
            if (ctx.in.Trg) {
                s.on = 1;
                s.until = null;
                return { Q: 1 };
            }
            if (s.on && !s.until) {
                s.until = ctx.now + ms(ctx.p.T); // trigger just went off: run on
            }
            if (s.on && ctx.now < s.until) {
                ctx.wake(s.until);
                return { Q: 1 };
            }
            s.on = 0;
            s.until = null;
            return { Q: 0 };
        },
    },
    onoffdelay: {
        group: 'Zeiten',
        label: 'Ein-/Ausschaltverzögerung',
        symbol: '⊓⊓',
        inputs: [
            { name: 'Trg', open: 0 },
            { name: 'R', open: 0 },
        ],
        outputs: ['Q'],
        params: [
            { key: 'TH', label: 'Einschaltverzögerung', type: 'time', default: 5, unit: 's', help: TIME_HELP },
            { key: 'TL', label: 'Ausschaltverzögerung', type: 'time', default: 5, unit: 's', help: TIME_HELP },
        ],
        evaluate: ctx => {
            const { s } = ctx;
            if (ctx.in.R) {
                Object.assign(s, { q: 0, since: null, until: null });
                return { Q: 0 };
            }
            if (ctx.in.Trg) {
                s.until = null;
                if (!s.q) {
                    s.since = s.since || ctx.now;
                    const at = s.since + ms(ctx.p.TH);
                    if (ctx.now >= at) {
                        s.q = 1;
                    } else {
                        ctx.wake(at);
                    }
                }
            } else {
                s.since = null;
                if (s.q) {
                    s.until = s.until || ctx.now + ms(ctx.p.TL);
                    if (ctx.now >= s.until) {
                        s.q = 0;
                        s.until = null;
                    } else {
                        ctx.wake(s.until);
                    }
                }
            }
            return { Q: b(s.q) };
        },
    },
    wiper: {
        group: 'Zeiten',
        label: 'Wischrelais (Impuls)',
        symbol: '⊓̲',
        inputs: [
            { name: 'Trg', open: 0 },
            { name: 'R', open: 0 },
        ],
        outputs: ['Q'],
        params: [{ key: 'T', label: 'Impulsdauer (höchstens)', type: 'time', default: 2, unit: 's', help: TIME_HELP }],
        evaluate: ctx => {
            const { s } = ctx;
            const edge = rising(s, 'trg', ctx.in.Trg);
            if (ctx.in.R || !ctx.in.Trg) {
                s.until = null;
                return { Q: 0 };
            }
            if (edge) {
                s.until = ctx.now + ms(ctx.p.T);
            }
            if (s.until && ctx.now < s.until) {
                ctx.wake(s.until);
                return { Q: 1 };
            }
            s.until = null;
            return { Q: 0 };
        },
    },
    edgepulse: {
        group: 'Zeiten',
        label: 'Flankengetriggerter Impuls',
        symbol: '↑⊓',
        inputs: [
            { name: 'Trg', open: 0 },
            { name: 'R', open: 0 },
        ],
        outputs: ['Q'],
        params: [{ key: 'T', label: 'Impulsdauer', type: 'time', default: 2, unit: 's', help: TIME_HELP }],
        evaluate: ctx => {
            const { s } = ctx;
            if (rising(s, 'trg', ctx.in.Trg)) {
                s.until = ctx.now + ms(ctx.p.T);
            }
            if (ctx.in.R) {
                s.until = null;
            }
            if (s.until && ctx.now < s.until) {
                ctx.wake(s.until);
                return { Q: 1 };
            }
            s.until = null;
            return { Q: 0 };
        },
    },
    staircase: {
        group: 'Zeiten',
        label: 'Treppenlichtschalter',
        symbol: '⌂',
        inputs: [
            { name: 'Trg', open: 0 },
            { name: 'R', open: 0 },
        ],
        outputs: ['Q'],
        params: [{ key: 'T', label: 'Leuchtdauer', type: 'time', default: 180, unit: 's', help: 'Jeder neue Impuls startet die Zeit neu' }],
        evaluate: ctx => {
            const { s } = ctx;
            // retriggerable: every rising edge (and a held trigger) restarts the time
            if (rising(s, 'trg', ctx.in.Trg) || ctx.in.Trg) {
                s.until = ctx.now + ms(ctx.p.T);
            }
            if (ctx.in.R) {
                s.until = null;
            }
            if (s.until && ctx.now < s.until) {
                ctx.wake(s.until);
                return { Q: 1 };
            }
            s.until = null;
            return { Q: 0 };
        },
    },
    clock: {
        group: 'Zeiten',
        label: 'Taktgeber',
        symbol: '⊓⊔',
        inputs: [{ name: 'En', open: 1 }],
        outputs: ['Q'],
        params: [
            { key: 'TH', label: 'Ein-Zeit', type: 'time', default: 1, unit: 's', help: TIME_HELP },
            { key: 'TL', label: 'Aus-Zeit', type: 'time', default: 1, unit: 's', help: TIME_HELP },
        ],
        evaluate: ctx => {
            const { s } = ctx;
            if (!ctx.in.En) {
                s.next = null;
                s.q = 0;
                return { Q: 0 };
            }
            if (!s.next) {
                s.q = 1;
                s.next = ctx.now + ms(ctx.p.TH);
            }
            while (ctx.now >= s.next) {
                s.q = s.q ? 0 : 1;
                s.next += Math.max(100, s.q ? ms(ctx.p.TH) : ms(ctx.p.TL));
            }
            ctx.wake(s.next);
            return { Q: s.q };
        },
    },

    // ---------------- memory and counters ----------------
    rs: {
        group: 'Speicher und Zähler',
        label: 'RS-Speicher',
        symbol: 'RS',
        inputs: [
            { name: 'S', open: 0 },
            { name: 'R', open: 0 },
        ],
        outputs: ['Q'],
        retain: true,
        params: [{ key: 'retain', label: 'Nach Neustart behalten (remanent)', type: 'bool', default: true }],
        evaluate: ctx => {
            const { s } = ctx;
            if (ctx.in.R) {
                s.q = 0; // reset wins, like the LOGO! RS relay
            } else if (ctx.in.S) {
                s.q = 1;
            }
            return { Q: b(s.q) };
        },
    },
    toggle: {
        group: 'Speicher und Zähler',
        label: 'Stromstoßrelais',
        symbol: 'T',
        inputs: [
            { name: 'Trg', open: 0 },
            { name: 'S', open: 0 },
            { name: 'R', open: 0 },
        ],
        outputs: ['Q'],
        retain: true,
        params: [{ key: 'retain', label: 'Nach Neustart behalten (remanent)', type: 'bool', default: true }],
        evaluate: ctx => {
            const { s } = ctx;
            const edge = rising(s, 'trg', ctx.in.Trg);
            if (ctx.in.R) {
                s.q = 0;
            } else if (ctx.in.S) {
                s.q = 1;
            } else if (edge) {
                s.q = s.q ? 0 : 1;
            }
            return { Q: b(s.q) };
        },
    },
    counter: {
        group: 'Speicher und Zähler',
        label: 'Vor-/Rückwärtszähler',
        symbol: '+/−',
        inputs: [
            { name: 'Cnt', open: 0 },
            { name: 'Dir', open: 0 },
            { name: 'R', open: 0 },
        ],
        outputs: ['Q', 'AQ'],
        retain: true,
        params: [
            { key: 'on', label: 'Q ein ab Zählerstand', type: 'number', default: 10 },
            { key: 'off', label: 'Q aus unter Zählerstand', type: 'number', default: 10 },
            { key: 'start', label: 'Startwert', type: 'number', default: 0 },
            { key: 'retain', label: 'Nach Neustart behalten (remanent)', type: 'bool', default: true },
        ],
        evaluate: ctx => {
            const { s, p } = ctx;
            if (s.count === undefined || ctx.in.R) {
                s.count = num(p.start);
            }
            if (rising(s, 'cnt', ctx.in.Cnt) && !ctx.in.R) {
                s.count += ctx.in.Dir ? -1 : 1;
            }
            if (s.count >= num(p.on)) {
                s.q = 1;
            } else if (s.count < num(p.off)) {
                s.q = 0;
            }
            return { Q: b(s.q), AQ: s.count };
        },
    },
    hours: {
        group: 'Speicher und Zähler',
        label: 'Betriebsstundenzähler',
        symbol: 'h',
        inputs: [
            { name: 'En', open: 0 },
            { name: 'R', open: 0 },
        ],
        outputs: ['AQ'],
        retain: true,
        params: [{ key: 'retain', label: 'Nach Neustart behalten (remanent)', type: 'bool', default: true }],
        evaluate: ctx => {
            const { s } = ctx;
            s.ms = s.ms || 0;
            if (ctx.in.R) {
                s.ms = 0;
            }
            if (s.running && s.last) {
                s.ms += ctx.now - s.last;
            }
            s.running = Boolean(ctx.in.En) && !ctx.in.R;
            s.last = ctx.now;
            if (s.running) {
                ctx.wake(ctx.now + 60000); // count up once a minute
            }
            return { AQ: Math.round((s.ms / 3600000) * 100) / 100 };
        },
    },

    // ---------------- analog ----------------
    threshold: {
        group: 'Analog',
        label: 'Schwellwertschalter',
        symbol: 'A>',
        inputs: [{ name: 'Ax', open: 0 }],
        outputs: ['Q'],
        params: [
            { key: 'on', label: 'Ein ab', type: 'number', default: 25 },
            { key: 'off', label: 'Aus unter', type: 'number', default: 23, help: 'Ein > Aus = Hysterese; Ein < Aus = Fenster (Ein zwischen den Werten)' },
        ],
        evaluate: ctx => {
            const { s, p } = ctx;
            const v = num(ctx.in.Ax);
            const on = num(p.on);
            const off = num(p.off);
            if (on >= off) {
                if (v >= on) {
                    s.q = 1;
                } else if (v < off) {
                    s.q = 0;
                }
            } else {
                s.q = b(v >= on && v < off); // window
            }
            return { Q: b(s.q) };
        },
    },
    compare: {
        group: 'Analog',
        label: 'Analogkomparator',
        symbol: 'A?B',
        inputs: [
            { name: 'A', open: 0 },
            { name: 'B', open: 0 },
        ],
        outputs: ['Q'],
        params: [
            {
                key: 'op',
                label: 'Bedingung',
                type: 'select',
                default: '>',
                options: [
                    ['>', 'A > B'],
                    ['>=', 'A ≥ B'],
                    ['<', 'A < B'],
                    ['<=', 'A ≤ B'],
                    ['==', 'A = B'],
                    ['!=', 'A ≠ B'],
                ],
            },
        ],
        evaluate: ctx => {
            const a = num(ctx.in.A);
            const c = num(ctx.in.B);
            const r = { '>': a > c, '>=': a >= c, '<': a < c, '<=': a <= c, '==': a === c, '!=': a !== c }[ctx.p.op];
            return { Q: b(r) };
        },
    },
    mux: {
        group: 'Analog',
        label: 'Analog-Auswahl (Multiplexer)',
        symbol: 'MUX',
        inputs: [
            { name: 'En', open: 1 },
            { name: 'S1', open: 0 },
            { name: 'S2', open: 0 },
        ],
        outputs: ['AQ'],
        params: [
            { key: 'V0', label: 'Wert bei En = 0', type: 'number', default: 0 },
            { key: 'V1', label: 'Wert bei S1=0, S2=0', type: 'number', default: 100 },
            { key: 'V2', label: 'Wert bei S1=1, S2=0', type: 'number', default: 20 },
            { key: 'V3', label: 'Wert bei S1=0, S2=1', type: 'number', default: 50 },
            { key: 'V4', label: 'Wert bei S1=1, S2=1', type: 'number', default: 0 },
        ],
        evaluate: ctx => {
            const { p } = ctx;
            if (!ctx.in.En) {
                return { AQ: num(p.V0) };
            }
            const i = (ctx.in.S1 ? 1 : 0) + (ctx.in.S2 ? 2 : 0);
            return { AQ: num(p[`V${i + 1}`]) };
        },
    },
    amp: {
        group: 'Analog',
        label: 'Analogverstärker (Skalieren)',
        symbol: '×+',
        inputs: [{ name: 'Ax', open: 0 }],
        outputs: ['AQ'],
        params: [
            { key: 'gain', label: 'Faktor', type: 'number', default: 1 },
            { key: 'offset', label: 'Offset', type: 'number', default: 0 },
            { key: 'decimals', label: 'Nachkommastellen', type: 'number', default: 2 },
        ],
        evaluate: ctx => {
            const f = Math.pow(10, Math.max(0, Math.min(6, num(ctx.p.decimals))));
            return { AQ: Math.round((num(ctx.in.Ax) * num(ctx.p.gain) + num(ctx.p.offset)) * f) / f };
        },
    },
    math: {
        group: 'Analog',
        label: 'Rechnen',
        symbol: '+−×÷',
        inputs: [
            { name: 'A', open: 0 },
            { name: 'B', open: 0 },
        ],
        outputs: ['AQ'],
        params: [
            {
                key: 'op',
                label: 'Rechenart',
                type: 'select',
                default: '+',
                options: [
                    ['+', 'A + B'],
                    ['-', 'A − B'],
                    ['*', 'A × B'],
                    ['/', 'A ÷ B'],
                    ['min', 'kleinerer Wert'],
                    ['max', 'größerer Wert'],
                    ['avg', 'Mittelwert'],
                ],
            },
        ],
        evaluate: ctx => {
            const a = num(ctx.in.A);
            const c = num(ctx.in.B);
            const r = { '+': a + c, '-': a - c, '*': a * c, '/': c === 0 ? 0 : a / c, min: Math.min(a, c), max: Math.max(a, c), avg: (a + c) / 2 }[ctx.p.op];
            return { AQ: Math.round(r * 1e6) / 1e6 };
        },
    },

    // ---------------- time switches ----------------
    weekly: {
        group: 'Zeitschaltuhren',
        label: 'Wochenschaltuhr',
        symbol: '⏲',
        inputs: [],
        outputs: ['Q'],
        params: [
            {
                key: 'schedule',
                label: 'Zeiten',
                type: 'text',
                default: 'Mo-Fr 06:30-22:00; Sa,So 08:00-23:00',
                help: 'z. B. "Mo-Fr 06:30-22:00; Sa,So 08:00-23:00" oder "täglich 22:00-06:00"',
            },
        ],
        evaluate: ctx => {
            const st = scheduleState(parseSchedule(ctx.p.schedule), ctx.now);
            ctx.wake(st.next);
            return { Q: b(st.on) };
        },
    },
    astro: {
        group: 'Zeitschaltuhren',
        label: 'Astro-Uhr (Tag/Nacht)',
        symbol: '☀',
        inputs: [],
        outputs: ['Tag', 'Nacht'],
        params: [
            { key: 'riseOffset', label: 'Sonnenaufgang verschieben', type: 'number', default: 0, unit: 'min', help: '+30 = Tag beginnt 30 min nach Sonnenaufgang' },
            { key: 'setOffset', label: 'Sonnenuntergang verschieben', type: 'number', default: 0, unit: 'min', help: '-15 = Nacht beginnt 15 min vor Sonnenuntergang' },
        ],
        evaluate: ctx => {
            const loc = ctx.location;
            if (!loc) {
                return { Tag: 1, Nacht: 0 };
            }
            const today = sunTimes(ctx.now, loc.latitude, loc.longitude);
            const rise = today.rise + num(ctx.p.riseOffset) * 60000;
            const set = today.set + num(ctx.p.setOffset) * 60000;
            const day = ctx.now >= rise && ctx.now < set;
            // next change: rise or set today, else sunrise tomorrow
            const tomorrow = sunTimes(ctx.now + 86400000, loc.latitude, loc.longitude).rise + num(ctx.p.riseOffset) * 60000;
            ctx.wake([rise, set, tomorrow].filter(t => t > ctx.now).sort((x, y) => x - y)[0] || ctx.now + 3600000);
            return { Tag: b(day), Nacht: b(!day) };
        },
    },
};

/** Normalized definition (inputs as objects). */
function definition(type) {
    const d = BLOCKS[type];
    if (!d) {
        return null;
    }
    return { type, params: [], ...d, inputs: d.inputs.map(i => (typeof i === 'string' ? { name: i, open: 0 } : i)) };
}

/** Definitions for the editor (without code). */
function catalog() {
    return Object.keys(BLOCKS).map(type => {
        const d = definition(type);
        return { type, group: d.group, label: d.label, symbol: d.symbol, inputs: d.inputs, outputs: d.outputs, params: d.params };
    });
}

module.exports = { BLOCKS, definition, catalog, parseSchedule, scheduleState };
