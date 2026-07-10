# SpeedFinePilot Auto – kostenlose PWA

Diese Version ersetzt die manuelle Tempolimit-Bedienung im Normalbetrieb durch eine automatische Erkennung.

## Was neu ist

- automatische Zuordnung zur wahrscheinlich befahrenen Straße
- Abgleich von GPS-Position, Straßengeometrie und Fahrtrichtung
- Unterstützung von `maxspeed`, `maxspeed:forward`, `maxspeed:backward`, `maxspeed:motorcar`, `maxspeed:type`, `source:maxspeed` und `zone:maxspeed`
- Ableitung deutscher Standardlimits, soweit die OSM-Tags dies hergeben
- stabilisierte GPS-Geschwindigkeit und Straßenerkennung
- automatische Löschung einer temporären Schild-Korrektur beim Straßenwechsel
- alternative Overpass-Instanz bei Ausfall
- Bildschirm-Wachhaltung, soweit iOS/Safari dies unterstützt
- Offline-Cache für die App-Oberfläche; die Tempolimiterkennung selbst benötigt Internet

## In dein bestehendes GitHub-Pages-Repository hochladen

1. ZIP entpacken.
2. Repository auf GitHub öffnen.
3. `Add file` → `Upload files`.
4. **Alle Dateien aus diesem Ordner direkt in den Hauptordner des Repositories ziehen.**
5. Vorhandene Dateien mit gleichem Namen ersetzen.
6. `Commit changes` auswählen.
7. In GitHub unter `Actions` oder `Settings` → `Pages` prüfen, bis das Deployment abgeschlossen ist.
8. Die App auf dem iPhone vollständig schließen und neu öffnen. Bei einer alten Ansicht Safari einmal neu laden oder die Home-Screen-App entfernen und erneut hinzufügen.

`index.html` muss direkt im Hauptordner liegen, nicht in einem zusätzlichen Unterordner.

## Auf dem iPhone verwenden

1. GitHub-Pages-Link in Safari öffnen.
2. Teilen → `Zum Home-Bildschirm`.
3. App öffnen.
4. `Automatik starten` drücken.
5. Standortzugriff auf `Beim Verwenden der App` beziehungsweise `Erlauben` stellen.

## Technische und rechtliche Grenzen

- Eine PWA kann keine Verkehrszeichen mit der Kamera erkennen.
- OpenStreetMap-Daten können fehlen, veraltet oder für die falsche Fahrtrichtung erfasst sein.
- Baustellen, Wechselverkehrszeichen, Wetter-, Fahrzeug- und Zusatzschildbedingungen sind nicht vollständig automatisch erkennbar.
- An Kreuzungen, parallelen Straßen, Tunneln und mehrstöckigen Straßen kann GPS die falsche Straße zuordnen.
- iOS kann Browser-Apps im Hintergrund oder bei gesperrtem Bildschirm anhalten. Die App sollte sichtbar geöffnet bleiben.
- Die Bußgeldanzeige ist eine Orientierung für normale Pkw bis 3,5 t, ohne Messtoleranz und ohne Sonder-/Wiederholungstäterfälle.
- Maßgeblich sind immer die Verkehrszeichen und die geltenden Vorschriften vor Ort.

## Datenschutz

Es gibt kein eigenes Backend. GPS-Koordinaten werden direkt vom Browser an einen öffentlichen Overpass-Dienst gesendet, um nahe OSM-Straßen abzurufen. Die App speichert keine Fahrthistorie auf einem eigenen Server.
