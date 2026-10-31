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
- **Mehrere markieren**: `Shift`/`Strg` + Klick auf Bausteine, **Shift + Rahmen ziehen** oder **⬚ Markieren**
  (dann zieht man auf der Fläche einen Rahmen – praktisch am Touch-Bildschirm), `Strg+A` = alle, `Esc` hebt auf.
  Markierte Bausteine werden gemeinsam verschoben und gelöscht.
- **Kopieren auf ein anderes Blatt**: markieren → **📋 Kopieren** (`Strg+C`) → anderen Programm-Reiter öffnen →
  **Einfügen** (`Strg+V`). Die Verbindungen zwischen den markierten Bausteinen kommen mit, Datenpunkte und
  Einstellungen auch. Eingefügt wird an der Mausposition; danach speichern.
- **Eingänge invertieren**: Baustein anklicken → rechts **„Eingänge invertieren“** – jeder Eingang jedes Bausteins
  (auch am Ausgang-Baustein, um den geschriebenen Wert umzudrehen). Ein kleiner Kreis am Eingang zeigt es an.
- **Verschieben/Zoomen**: Fläche ziehen, Mausrad; **⤢ Alles** zeigt das ganze Programm.
- **Speichern** (`Strg+S`): das Programm läuft sofort mit den neuen Einstellungen; ändert sich dadurch ein Ergebnis
  (z. B. Eingang invertiert), wird der Ausgang gleich geschrieben.
- **aktiv**: Programm ein/aus. **Live**: Leitungen mit Wert 1 werden grün, Zahlenwerte stehen an
  den Ausgängen, laufende Zeiten mit ⏱ Restzeit.
- **Live bei Ein-/Ausgängen**: Die Lampe oben rechts leuchtet grün, wenn das Signal ein ist. Die
  unterste Zeile zeigt den Wert, wie er in ioBroker steht:
  - Eingang: `true · vor 5 s` - Wert und wann der Datenpunkt zuletzt aktualisiert wurde. Bei jeder
    Aktualisierung blinkt der Rahmen kurz blau, so sieht man, dass das Signal wirklich ankommt.
  - Ausgang: `soll 20 · ist 20 % ✓` - **soll** = was die Logik ausgibt, **ist** = Wert in ioBroker.
    ✓ = vom Gerät bestätigt, ⏳ = gesendet, noch nicht bestätigt, ≠ = Datenpunkt hat einen anderen
    Wert (z. B. von Hand geschaltet - Ausgänge werden nur bei einer Änderung geschrieben).

Ausgänge werden geschrieben, **wenn sich das Ergebnis ändert** - nicht beim Start des Adapters. Ein von Hand
geschaltetes Licht wird also nicht überschrieben, nur weil der Adapter neu startet.

## Bausteine

| Gruppe | Bausteine |
| --- | --- |
| Ein-/Ausgänge | Eingang (Datenpunkt, optional invertiert), Ausgang (Ein/Aus oder Zahl), Konstante, Notiz |
| Grundfunktionen | UND, NAND, ODER, NOR (je 2–8 Eingänge, „Anzahl Eingänge“), XOR, NICHT, Flanke steigend, Flanke fallend |
| Heizung | Raumregler (PI) |
| Zeiten | Einschalt-, Ausschalt-, Ein-/Ausschaltverzögerung, Wischrelais, flankengetriggerter Impuls, Treppenlichtschalter, Taktgeber, Flackern (zufällig) |
| Speicher und Zähler | RS-Speicher, Stromstoßrelais, Vor-/Rückwärtszähler, Betriebsstundenzähler (remanent: bleiben nach Neustart erhalten) |
| Analog | Schwellwertschalter (Hysterese/Fenster), Analogkomparator, Analog-Auswahl (Multiplexer), Analogverstärker, Rechnen |
| Zeitschaltuhren | Wochenschaltuhr („Mo-Fr 06:30-22:00; Sa,So 08:00-23:00“), Astro-Uhr Tag/Nacht mit Verschiebung |

Wie bei der LOGO!: offene Eingänge von UND/NAND zählen als 1, von ODER/NOR als 0. Alle Werte sind
Zahlen; Ein/Aus = 1/0. Die Astro-Uhr nutzt den Standort aus den ioBroker-Systemeinstellungen.

## Mitteilung (Push) über SmartView

Baustein **„Mitteilung (Push)“** (Gruppe Ein-/Ausgänge): Titel und Text eintragen, Eingang verdrahten. Wird
der Eingang **Ein**, schickt SmartView die Mitteilung – als App-Push und, wenn dort eingerichtet, über
Telegram und WhatsApp. Beispiel „Fenster länger als 15 Minuten offen und Heizung an“:
Eingang Fenster + Eingang Heizung → **UND** → **Einschaltverzögerung** 900 s → **Mitteilung**.
Datenpunkt ist `smartview.0.push.message` (bei einer anderen SmartView-Instanz anpassen).

## Beispiel: Einzelraumregelung (statt Gira HomeServer)

„Beispiel einfügen“ → **3 = Einzelraumregelung**: Ist-Temperatur + Sollwert → **Raumregler (PI)** → Stellgröße in %
an den Heizungsaktor – so, wie es ein HomeServer oder KNX-Raumregler macht.

- **Eingänge:** Ist, Soll, **En** (Freigabe Heizung; nicht verbunden = immer frei), **Win** (Fenster offen → 0 %),
  **M** (Betriebsart KNX: 1 Komfort, 2 Standby, 3 Nacht, 4 Frostschutz; nicht verbunden = Komfort), **Cool** (1 = Kühlen),
  **RH** (Luftfeuchte %, für die Kühlsperre).
- **Kühlen über die Fußbodenheizung** (dieselben Stellantriebe): Umschaltung Heizen/Kühlen auf **Cool**. Achtung: KNX
  DPT 1.100 meldet **1 = Heizen, 0 = Kühlen** – am Eingang „Invertieren“ anhaken (in der Vorlage schon so). Gekühlt wird
  erst über **Soll + 2 K** (Totzone, einstellbar), beim Umschalten startet der I-Anteil neu. **Optional** eine
  Feuchte-Sperre („Kühlen sperren über Luftfeuchte“, z. B. 65 %, Luftfeuchte an RH) – standardmäßig aus, weil viele
  Wärmepumpen (z. B. die Ochsner) selbst eine Feuchte-/Taupunktsperre haben.
- **Ausgänge:** **Y** Stellgröße 0–100 %, **H** heizt (1 = Y > 0), **S** wirksamer Sollwert (nach Betriebsart).
- **Einstellwerte:** Proportionalbereich und Nachstellzeit wie bei KNX: Heizkörper 5 K / 150 min,
  **Fußbodenheizung 5 K / 240 min**, Elektroheizung 4 K / 100 min. Absenkung Standby 2 K, Nacht 4 K, Frostschutz 7 °C.
- Der Regler rechnet einmal pro Minute, merkt sich seinen Stand über Neustarts und läuft nicht „in die Grenze“
  (Anti-Windup). Fehlt die Ist-Temperatur (Fühler weg), bleibt die letzte Stellung.
- Am **Ausgang** „Zusätzlich zyklisch senden alle 10 min“: viele Heizungsaktoren überwachen die Stellgröße und gehen
  ohne regelmäßiges Telegramm in die Notstellung.
- Pro Raum einen Regler: die Bausteine kopieren oder mehrere Programme anlegen. Die SmartView-Heizungskachel bleibt das
  Bedienteil (Sollwert, Betriebsart, Anzeige der Stellgröße).

## Beispiel: Halloween-Flackern

„Beispiel einfügen“ → **2 = Halloween-Flackern**: Bewegungsmelder **und** Halloween-Schalter → Baustein **„Flackern
(zufällig)“** → Außenlicht. Das Licht flackert dann 20 Sekunden in zufälligen Abständen (mal kurz, mal ein Doppelblitz,
mal eine längere dunkle Pause) und ist danach **aus** – auch wenn der Bewegungsmelder schon vorher wieder abfällt;
jede neue Bewegung startet die 20 s neu. Der Eingang **R** des Bausteins stoppt sofort (z. B. ein Aus-Taster).

- Die `demo.*`-Datenpunkte durch die eigenen ersetzen (Bewegungsmelder, ein Schalter z. B. `0_userdata.0.Halloween`
  oder eine SmartView-Kachel, das Außenlicht) und das Programm aktiv schalten.
- **KNX-Schaltausgänge (Relais):** die „kürzeste Schaltzeit“ von 0,3 s nicht unterschreiten – das sind höchstens etwa
  3 Schaltungen pro Sekunde, schont Relais und Bus. Die Dauer begrenzt die Schaltspiele zusätzlich.
- Hängt am selben Licht noch eine normale Steuerung (Treppenlicht, Dämmerung), beide über ein **ODER** zusammenführen,
  sonst schreiben zwei Programme gegeneinander.

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
