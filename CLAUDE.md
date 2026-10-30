# ioBroker.logik

ioBroker adapter: graphical function block logic like a small PLC (owner knows Siemens LOGO! and
finds Blockly too complicated). Editor in the browser on the adapter's own port (8097).
First use case: solarium cabin (booking at card reader -> light 100 %, solarium on -> dimmed 20 %,
exit motion then door contact open -> off) - shipped as template `solarium`.

## Layout

- `lib/blocks.js` – block catalog: definition = group/label/symbol, inputs (with `open` value of an
  unconnected input: AND/NAND 1, OR/NOR 0 like LOGO!), outputs, params, `retain`, `evaluate(ctx)`.
  Values on wires are numbers (digital 0/1). Timers use `ctx.wake(at)`; one-cycle pulses wake at
  `now`. Weekly timer parses "Mo-Fr 06:30-22:00; ...". Astro uses `lib/sun.js` (sunrise equation)
  with the location from `system.config`.
- `lib/engine.js` – `Engine`: programs `{id, name, enabled, blocks, wires}`; signal-flow order
  (Kahn), feedback loops repeated until stable (max 10 passes); event driven (input change or
  wake-up); outputs emitted as 'write' only when the result changes, never at start/reload;
  `retained()` for remanent blocks (RS, toggle, counter, hours unless param retain = false).
- `lib/store.js` – programs.json / retain.json in the instance data dir (atomic write), `_clean()`
  validates editor input; templates start disabled.
- `lib/server.js` – editor files (www/), REST API (`/api/catalog`, `/api/programs`, `/api/states`),
  `/ws` live snapshots (throttled 300 ms). Optional access key for API/WS.
- `www/picker.js` – object browser (0.2.0, asked for by the owner "wie bei Blockly"): tree by ID
  segments (adapter.instance as first level), folder names, search, values via `POST /api/values`,
  objects via `/api/objects` (cached 5 min in main.js, `?fresh=1` reloads, gzip). Opens on adding an
  input/output, on double click (detected in pointerdown - blocks are re-rendered) and via 📂 Auswählen.
- `www/` – vanilla JS SVG editor: palette, drag/drop, wiring by dragging between ports, params panel
  with state search (datalist), program tabs, fit view, live colouring and remaining times.
- Live view of I/O blocks (0.3.0, owner wants to see that signals really arrive): main.js also
  subscribes outputs and keeps `{val, ack, ts}` per data point (`stateInfo`); live messages carry
  `states` + `now` (clock offset for "vor 5 s"); output line soll/ist with ✓ (ack) ⏳ (sent) ≠ (differs).
  0.3.1 field: owner saw "kein Wert in ioBroker" for a valid data point - it was chosen but not saved
  (or the push came before reload had read the values). Unsaved ids now via `POST /api/values`
  ("Speichern für Live"), reload ends with `server.stateChanged()`.
- `main.js` – subscribes the input data points (foreign), presets values, writes outputs
  (`setForeignState` ack=false; type from the object or the output's mode), saves remanent values
  every 30 s and on unload.
- `test/` – engine/blocks with a fake clock (incl. the solarium scenario), adapter with a fake
  ioBroker + real HTTP/WS. The editor was checked with Playwright (scratchpad, not in npm test).

- 0.4.0: owner wanted push rules with logic -> block `notify` (title, text, target smartview.N.push.message):
  engine emits 'notify' when its input becomes 1 (not at start, like outputs); main writes JSON {title, text}
  to the target (only smartview.N.push.message allowed). SmartView sends it to app/Telegram/WhatsApp.

- 0.5.0: owner (KNX switch actuators) asked for Halloween horror flickering of outside lights from a motion detector ->
  block `flicker` (En; T max duration, onMin/onMax, offMin/offMax, min = shortest switching time, default 0.3 s for relays;
  random times, 15 % long dark pause, 20 % quick double flash; since 0.5.1 a rising edge of En starts T seconds even
  if En drops (motion detectors drop early), T = 0 = while En, R stops at once, the end keeps `min` after the last switch
  (0.5.0's random test caught a 0.1 s switch at the end); after that Q = 0. Engine option `random` (seeded in tests,
  300 seeds checked for >= 300 ms between switchings);
  `ctx.random` can be injected), template `halloween` (motion AND switch -> flicker -> bool output), editor
  "Beispiel einfügen" asks 1 = Solarium / 2 = Halloween. Engine test with fake clock. Not tried on the owner's KNX.

- 0.6.0: owner wants to switch off the Gira HomeServer, which did the room heating control (GAs Istwert 1/1/x, Sollwert
  1/0/x -> Stellgröße 1/3/x DPT 5.001) -> block `pi` (group Heizung): inputs Ist, Soll, En (open 1), Win, M (HVAC 1-4,
  open 1), Cool; outputs Y (0-100 %), H, S (effective set point); params Xp (K), Tn (min), standby/night offsets, frost,
  every (s, default 60); position form P + I, conditional integration (anti-windup), I clamped 0-100, retain; En off ->
  I reset; window -> 0 % with I kept; invalid temps (ist outside 1-60, soll outside 5-35; missing inputs read 0) -> last Y.
  Output block param `cyclic` (min): engine writes again after that time (`writtenAt`, wake). Template `room`, editor
  example 3. Engine tests with fake clock. Not yet on the owner's KNX.

- 0.6.1: owner cools via the floor heating with the heat pump, same valves, heat/cool switch -> pi `coolOffset` (dead band,
  default 2 K, cooling target = soll + offset, modes shift upwards), I reset when Cool changes (`s.cool`), input RH +
  `rhMax` (default 65 %, 0 = off) -> 0 % while too humid; template inputs heat/cool (inverted: KNX DPT 1.100 1 = heating)
  and humidity. 0.6.2: owner's heat pump has its own humidity lock -> `rhMax` default 0 (off), RH not in the template.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.logik`.
- Run `npm test` before committing.
- Don't call it "LOGO" in names (Siemens trademark); "wie eine Kleinsteuerung" is fine.
