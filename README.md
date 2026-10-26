# Siesta – Tabs automatisch entladen

Firefox-Add-on, das Tabs nach einer frei wählbaren Zeit ohne Nutzung entlädt
(`tabs.discard`), damit Firefox den Arbeitsspeicher freigibt. Der Tab bleibt in
der Tableiste stehen und lädt neu, sobald du ihn wieder anklickst.

Alles wird im Popup oben rechts bedient. Eine eigene Einstellungsseite gibt es nicht.

## Funktionen

- **Timer pro Tab**: Für jeden Tab einzeln festlegen, nach wie vielen Minuten
  ohne Nutzung er entladen wird (Nie, 5, 10, 15, 30 Minuten, 1 h, 2 h oder ein
  eigener Wert bis 24 h). Die Einstellung hängt am Tab und übersteht über den
  Sitzungsspeicher von Firefox auch einen Neustart.
- **Regel pro Website**: Alternativ gilt eine Zeit für alle Tabs einer Website,
  z. B. `teams.microsoft.com`.
- **Standard**: Optionale Zeit für alle übrigen Tabs (ab Werk: nie).
- **Rangfolge**: eigene Tab-Regel vor Website-Regel vor Standard.
- **Live-Übersicht**: Welche Tabs geladen und welche entladen sind, mit Countdown.
  Das Mond-Symbol nimmt ab, je näher das Entladen rückt.
- **Von Hand entladen**: einzelne Tabs, den aktuellen Tab (Firefox wechselt dann
  zum zuletzt genutzten Tab) oder alle inaktiven Tabs auf einmal.
- **Schutz**: Tabs mit Ton, mit Kamera-, Mikrofon- oder Bildschirmfreigabe und
  (beim Standard) angepinnte Tabs werden nicht entladen. Endet der Ton, beginnt
  die Wartezeit neu. Der gerade offene Tab eines Fensters wird nie automatisch entladen.
- **Statistik**: Entladungen der letzten 7 Tage (automatisch und von Hand),
  häufigste Websites, letzte Entladungen und wie viele Tabs später wieder
  geöffnet wurden.
- **Rechtsklick auf einen Tab**: Menü „Siesta“ mit „Jetzt entladen“ und den
  Timer-Werten, auch für mehrere markierte Tabs.
- **Automatik-Schalter** zum Pausieren; das Symbol zeigt dann „II“, sonst die
  Zahl der entladenen Tabs.

### Wann gilt ein Tab als „nicht genutzt“?

Die Zeit läuft ab dem Moment, in dem du den Tab verlässt (Firefox führt das als
`lastAccessed`). Solange ein Tab im Fenster ausgewählt ist, wird er nicht entladen.

### Grenzen

- Firefox gibt Add-ons keinen Speicherverbrauch einzelner Tabs preis. Die
  RAM-Angabe ist deshalb eine **Schätzung** (Standard 120 MB je Tab, in den
  Einstellungen anpassbar) und wird im Popup auch so bezeichnet.
- Ungespeicherte Eingaben in Formularen stellt Firefox nach dem Neuladen meist
  wieder her, aber nicht auf jeder Seite.

## Installieren

**Zum Ausprobieren** (bis zum nächsten Firefox-Neustart):
`about:debugging#/runtime/this-firefox` → „Temporäres Add-on laden …“ →
`manifest.json` aus diesem Ordner wählen.

**Dauerhaft**: Firefox-Release-Versionen installieren nur von Mozilla signierte
Add-ons. Die Signatur für den Eigengebrauch ist kostenlos und läuft automatisch
(Kanal „unlisted“, das Add-on erscheint dabei nicht öffentlich auf AMO):

1. API-Schlüssel anlegen: <https://addons.mozilla.org/developers/addon/api/key/>
2. Signieren:
   ```bash
   npx web-ext sign --channel=unlisted --api-key=… --api-secret=…
   ```
3. Die erzeugte `.xpi` aus `web-ext-artifacts/` in Firefox öffnen.

## Entwicklung

```bash
npx web-ext lint     # Prüfung durch Mozillas Linter
npx web-ext run      # Firefox mit dem Add-on starten
./build.sh           # unsignierte .xpi nach dist/
```

Aufbau:

| Datei | Aufgabe |
| --- | --- |
| `background.js` | Timer, Entladen, Statistik, Symbol-Zähler, Tab-Kontextmenü |
| `lib/core.js` | Gemeinsame Logik: Regeln auflösen, Tab-Status, Formatierung |
| `popup/` | Popup mit Tabs, Statistik und Einstellungen |

Gespeichert wird nur lokal: Einstellungen, Website-Regeln und Statistik in
`storage.local`, Tab-Regeln im Sitzungsspeicher (`sessions.setTabValue`). Das
Add-on sendet keine Daten.

## Berechtigungen

| Berechtigung | Wofür |
| --- | --- |
| `tabs` | Titel und Adresse der Tabs für Liste und Website-Regeln |
| `storage` | Einstellungen, Website-Regeln, Statistik |
| `alarms` | Zum richtigen Zeitpunkt entladen |
| `sessions` | Tab-Regeln über Neustarts hinweg am Tab speichern |
| `menus` | Rechtsklick-Menü auf Tabs |

## Lizenzen von Drittanbietern

- Schrift **Bricolage Grotesque** (Ateliertriay), SIL Open Font License 1.1,
  siehe `fonts/OFL.txt`.
