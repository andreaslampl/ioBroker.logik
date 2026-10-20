# ioBroker.logik

Grafische Logik für ioBroker - wie bei einer Kleinsteuerung (z. B. Siemens LOGO!): Bausteine auf
eine Fläche ziehen, mit der Maus verbinden, Ein- und Ausgänge mit ioBroker-Datenpunkten verknüpfen.
Für Abläufe, die in Blockly unübersichtlich werden.

## Installation

```
iob url https://github.com/andreaslampl/ioBroker.logik
```

Instanz anlegen, dann den **Editor** öffnen: Link der Instanz (Weltkugel) oder die Adresse im
Datenpunkt `logik.0.info.editorUrl`, z. B. `http://<ioBroker-IP>:8097/`.

## Bedienung

- **＋ Neu** legt ein Programm an; jedes Programm ist ein eigener Reiter. **Beispiel** fügt die
  Vorlage „Solarium-Kabine“ ein.
- **Bausteine**: links anklicken (erscheint in der Mitte) oder auf die Fläche ziehen.
- **Verbinden**: vom **Ausgang** (Punkt rechts) zu einem **Eingang** (Punkt links) ziehen. Ein
  Eingang hat genau eine Verbindung; eine neue ersetzt die alte.
- **Datenpunkt wählen**: Beim Hinzufügen eines Eingangs/Ausgangs, per **Doppelklick** darauf oder
  mit **📂 Auswählen** rechts öffnet sich die Objekt-Auswahl wie bei Blockly: Objektbaum mit Namen,
  Typ, Rolle und aktuellem Wert, Suchfeld (z. B. „licht küche“). Anklicken + **Übernehmen** oder
  Doppelklick. Bei Ausgängen blendet „nur schreibbare“ reine Anzeigewerte aus. **⟳** lädt neue
  Objekte nach.
- **Einstellen**: Baustein anklicken → rechts die Parameter. Die ID kann auch direkt eingetippt
  oder aus dem Admin (Objekte → ID kopieren) eingefügt werden.
- **Löschen**: Baustein oder Leitung anklicken, dann `Entf`.
- **Verschieben/Zoomen**: Fläche ziehen, Mausrad; **⤢ Alles** zeigt das ganze Programm.
- **Speichern** (`Strg+S`): das Programm läuft sofort mit den neuen Einstellungen.
- **aktiv**: Programm ein/aus. **Live**: Leitungen mit Wert 1 werden grün, Zahlenwerte stehen an
  den Ausgängen, laufende Zeiten mit ⏱ Restzeit.

Ausgänge werden geschrieben, **wenn sich das Ergebnis ändert** - nicht beim Start. Ein von Hand
geschaltetes Licht wird also nicht überschrieben, nur weil der Adapter neu startet.

## Bausteine

| Gruppe | Bausteine |
| --- | --- |
| Ein-/Ausgänge | Eingang (Datenpunkt, optional invertiert), Ausgang (Ein/Aus oder Zahl), Konstante, Notiz |
| Grundfunktionen | UND, NAND, ODER, NOR, XOR, NICHT, Flanke steigend, Flanke fallend |
| Zeiten | Einschalt-, Ausschalt-, Ein-/Ausschaltverzögerung, Wischrelais, flankengetriggerter Impuls, Treppenlichtschalter, Taktgeber |
| Speicher und Zähler | RS-Speicher, Stromstoßrelais, Vor-/Rückwärtszähler, Betriebsstundenzähler (remanent: bleiben nach Neustart erhalten) |
| Analog | Schwellwertschalter (Hysterese/Fenster), Analogkomparator, Analog-Auswahl (Multiplexer), Analogverstärker, Rechnen |
| Zeitschaltuhren | Wochenschaltuhr („Mo-Fr 06:30-22:00; Sa,So 08:00-23:00“), Astro-Uhr Tag/Nacht mit Verschiebung |

Wie bei der LOGO!: offene Eingänge von UND/NAND zählen als 1, von ODER/NOR als 0. Alle Werte sind
Zahlen; Ein/Aus = 1/0. Die Astro-Uhr nutzt den Standort aus den ioBroker-Systemeinstellungen.

## Beispiel: Solarium-Kabine

Buchung am Türleser → Licht 100 % (bleibt an) · Solarium läuft → Licht 20 % · Solarium aus →
wieder 100 % · Austritts-Bewegungsmelder und danach Tür auf → Licht aus. Über **Beispiel**
einfügen, die Datenpunkte `demo.*` durch die eigenen ersetzen, **aktiv** anhaken, speichern.

## Einstellungen

| Einstellung | Bedeutung |
| --- | --- |
| Port | Port des Editors (Standard 8097) |
| Zugriffsschlüssel | optional; dann muss der Editor mit `?key=…` geöffnet werden (wer den Editor öffnen kann, kann Datenpunkte schalten) |

Programme und remanente Werte liegen im Datenverzeichnis der Instanz (`programs.json`,
`retain.json`) und sind in der ioBroker-Sicherung enthalten.

## Entwicklung

```
npm install
npm test
```

## Lizenz

MIT
