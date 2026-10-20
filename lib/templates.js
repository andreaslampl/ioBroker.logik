'use strict';

/*
 * Ready-made example programs for the editor. Data points are placeholders ("demo.*") that the
 * user replaces with their own in the editor.
 */

/**
 * Solarium cabin: booking at the card reader switches the light on (stays on); while the
 * solarium runs the light is dimmed; leaving = exit motion detector, then door contact open -> off.
 */
function solarium() {
    const at = (x, y) => ({ x, y });
    return {
        name: 'Beispiel: Solarium-Kabine',
        enabled: true,
        blocks: [
            { id: 'note', type: 'comment', ...at(40, 0), params: { text: 'Buchung am Türleser → Licht 100 %. Solarium läuft → 20 %. Austritts-Bewegungsmelder, danach Tür auf → Licht aus. Datenpunkte (demo.*) durch die eigenen ersetzen.' } },
            { id: 'booked', type: 'input', ...at(40, 140), params: { state: 'demo.booked' } },
            { id: 'solarium', type: 'input', ...at(40, 240), params: { state: 'demo.solarium' } },
            { id: 'exit', type: 'input', ...at(40, 340), params: { state: 'demo.exitMotion' } },
            { id: 'door', type: 'input', ...at(40, 440), params: { state: 'demo.door' } },
            { id: 'occupied', type: 'rs', ...at(500, 140), params: { retain: true } },
            { id: 'leaving', type: 'rs', ...at(500, 340), params: { retain: true } },
            { id: 'exitWhileOccupied', type: 'and', ...at(280, 320) },
            { id: 'left', type: 'and', ...at(720, 380) },
            { id: 'resetLeaving', type: 'or', ...at(280, 480) },
            { id: 'light', type: 'mux', ...at(940, 140), params: { V0: 0, V1: 100, V2: 20, V3: 100, V4: 20 } },
            { id: 'dimmer', type: 'output', ...at(1140, 140), params: { state: 'demo.dimmer', mode: 'number' } },
        ],
        wires: [
            w('booked', 'Q', 'occupied', 'S'),
            w('left', 'Q', 'occupied', 'R'),
            w('exit', 'Q', 'exitWhileOccupied', 'I1'),
            w('occupied', 'Q', 'exitWhileOccupied', 'I2'),
            w('exitWhileOccupied', 'Q', 'leaving', 'S'),
            w('booked', 'Q', 'resetLeaving', 'I1'),
            w('left', 'Q', 'resetLeaving', 'I2'),
            w('resetLeaving', 'Q', 'leaving', 'R'),
            w('leaving', 'Q', 'left', 'I1'),
            w('door', 'Q', 'left', 'I2'),
            w('occupied', 'Q', 'light', 'En'),
            w('solarium', 'Q', 'light', 'S1'),
            w('light', 'AQ', 'dimmer', 'I'),
        ],
    };
}

function w(fromBlock, fromPort, toBlock, toPort) {
    return { from: { block: fromBlock, port: fromPort }, to: { block: toBlock, port: toPort } };
}

const TEMPLATES = { solarium };

module.exports = { TEMPLATES, solarium };
