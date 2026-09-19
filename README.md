# snar — Short-Links & QR-Codes, self-hosted

[![CI](https://github.com/chris-kretschmer/snar/actions/workflows/ci.yml/badge.svg)](https://github.com/chris-kretschmer/snar/actions/workflows/ci.yml)

snar ist ein selbst gehostetes Kurzlink-Tool mit dynamischen QR-Codes: Jeder Link bekommt automatisch einen QR-Code, der nur die Kurz-URL kodiert – druckst du ihn einmal, kannst du das eigentliche Ziel danach beliebig oft ändern, ohne neu drucken zu müssen. Dazu Nutzerverwaltung: Jede Person hat ihre eigenen, privaten Links, und alles mit Sichtbarkeit „Organisation“ landet im **Gemeinsamen Tresor** – einer QR-Galerie, die das ganze Team einsehen und bearbeiten kann. Ergänzt durch einen statischen QR-Code-Generator (auch für WLAN-Zugangsdaten und SEPA-Überweisungen) und Klick-Statistik pro Link. Ohne externe Dienste, ohne Cookies für Besucher der Kurzlinks selbst.

## Features

- **Short-Links** – Zufalls-Slug (56-Zeichen-Alphabet ohne verwechselbare Zeichen wie `0`/`O`/`o` oder `1`/`I`/`l`) oder eigener Wunsch-Slug, Titel für die interne Übersicht, Ziel jederzeit änderbar. Ein paar Wörter (`app`, `login`, `logout`, `static`, `healthz`, `favicon.ico`, `robots.txt`) sind als Slug reserviert.
- **Dynamische QR-Codes** – als SVG oder PNG bis 4096 px, Redirect per `302` + `Cache-Control: no-store`.
- **Statischer QR-Code-Generator** – Vier Eingabe-Arten: URL, freier Text, WLAN-Zugangsdaten, SEPA-Überweisung/GiroCode. Eigene Vorder-/Hintergrundfarbe, auch transparent. Wird **nicht gespeichert** und läuft komplett über POST, damit der Inhalt nicht in Adressleiste, Browser-Verlauf oder Access-Logs landet.
- **Statistik pro Link** – Kennzahlen (Klicks gesamt, heute, letzte 7/30 Tage, Ø pro Tag, letzter Klick), Klickverlauf als Diagramm mit Zeitraum Heute/7 Tage/30 Tage/12 Monate/Gesamt oder frei wählbar (per Tastatur bedienbar), Besuchende (Quelle nur als Hostname, Gerätetyp, Browser, Sprache; ab fünf Einträgen mit „Weitere“-Dialog) und die letzten Klicks zum Durchblättern. Bewusst datensparsam: keine IP-Speicherung, kein Fingerprinting.
- **Nutzerverwaltung** – Rollen Admin/Mitglied. Admins legen Accounts an (Startpasswort, Wechsel unter „Konto“) und löschen sie – deren Links werden automatisch an eine andere Person übertragen, nichts geht verloren. Der letzte Admin und das eigene Konto sind gegen Löschung geschützt. Passwörter werden mit scrypt gehasht.
- **Sichtbarkeit pro Link** – „Persönlich“ (nur Besitzer:in und Admins) oder „Organisation“: Org-Links gehören dem ganzen Team, erscheinen im Gemeinsamen Tresor, und jedes angemeldete Mitglied darf sie bearbeiten und mit voller Klick-Statistik einsehen – „Erstellt von“ ist dabei rein informativ und schränkt nichts ein. Löschen und die Sichtbarkeit ändern bleiben Besitzer:in/Admin vorbehalten.
- **Domain-Verwaltung** – Kurz-Domains werden in der App verwaltet (`/app/domains`, nur Admins), nicht in der Konfiguration – Hinzufügen/Entfernen wirkt sofort, kein Neustart nötig. Die erste in der Liste ist die Standard-Domain für neue Links. Eine Domain zu entfernen stellt betroffene Links automatisch auf eine andere um, kein gedruckter QR-Code bricht dadurch.
- **Auth** – Signierte HttpOnly-Sessions (30 Tage, sofort ungültig bei Nutzerlöschung oder Passwortwechsel – dabei werden gezielt alle anderen Geräte abgemeldet, das aktuelle bleibt angemeldet), Login-Rate-Limit. Optional **SSO über OIDC** (z. B. Authentik) als zusätzlicher Login-Weg neben Nutzername/Passwort – der erste erfolgreiche SSO-Login legt automatisch einen Account als „Mitglied“ an, Admin-Rechte bleiben weiterhin nur manuell vergebbar.
- **Ein Container, eine SQLite-Datei** (`/data/snar.db`, WAL-Modus) – siehe „Wichtig zu wissen“ für den sicheren Backup-Befehl.

## Voraussetzungen

- **Mit Docker** (empfohlen): Docker + Docker Compose Plugin.
- **Ohne Docker**: Node.js `^20.19` oder `>=22.12`.

## Schnellstart (Docker)

```bash
cp .env.example .env   # dann ADMIN_PASSWORD & Co. in .env eintragen
docker compose up -d --build
```

`compose.yaml` liest die Zugangsdaten aus einer lokalen `.env`-Datei (nicht im Repo, siehe `.gitignore`) – **niemals echte Passwörter direkt in `compose.yaml` eintragen**, das landet sonst in der Versionskontrolle. Ohne gesetztes `ADMIN_PASSWORD` bricht der Start bewusst mit einer Fehlermeldung ab, statt mit einem Standard-Passwort hochzufahren.

Werte in `.env`:

| Variable | Bedeutung |
|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | Legen **nur beim allerersten Start** das erste Admin-Konto an (Standardname `admin`, Passwort mind. 8 Zeichen). Danach läuft alles über die Nutzerverwaltung in der App |
| `BASE_URL` / `DOMAINS` | Legen **nur beim allerersten Start** den Startbestand der Kurz-Domain(s) an (`DOMAINS` kommagetrennt für mehrere, z. B. `https://a.tld,https://b.tld`) – **steht in den QR-Codes**, also eine Domain wählen, die dauerhaft bleibt. Danach unter „Domains“ (`/app/domains`) verwaltbar, diese Variablen werden dann ignoriert |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Optional, aktiviert SSO-Login über einen OIDC-Provider (z. B. Authentik). Erst aktiv, wenn alle drei gesetzt sind. Redirect-URI beim Provider registrieren: `<erste konfigurierte Domain>/login/sso/callback` |
| `TZ` | Zeitzone für die Statistik-Diagramme (z. B. `Europe/Berlin`) – bestimmt, wo Tages-/Stundengrenzen schneiden. Gespeichert wird immer UTC |
| `PORT` | Standard `3000` |
| `DATA_DIR` | Standard `/data` (Volume) |

Danach: `http://<server-adresse>:3000` → anmelden → Links anlegen. Für Monitoring/Reverse-Proxy-Healthchecks gibt es `GET /healthz`.

## Ohne Docker

Für Bare-Metal-Betrieb oder ein eigenes Init-System – ansonsten ist der Docker-Weg oben der einfachere Standardfall.

```bash
npm install
ADMIN_PASSWORD=geheim123 BASE_URL=https://example.com node src/server.js
```

## Ressourcenverbrauch

Gemessen: Leerlauf ~66 MB RSS, unter Dauerlast ~110 MB, CPU im Leerlauf null. Ein Redirect kostet ~1–2 ms CPU, teuerste Operation ist das 1024-px-PNG-Rendering (~100 ms, nur bei explizitem Download – die Galerien nutzen SVG). `compose.yaml` setzt `cpus: 0.5` als Sicherheitsnetz sowie eine Log-Rotation (`max-size: 10m`, `max-file: 3`), damit Docker-eigene Logs bei jahrelangem Dauerbetrieb nicht unbegrenzt wachsen. Das Image wird mehrstufig gebaut (Build-Toolchain für `better-sqlite3` bleibt vollständig im Builder-Stage), sodass das Laufzeit-Image schlank bleibt.

## Wichtig zu wissen

- **Kurz-Domain nie wechseln**, sobald QR-Codes gedruckt sind – die URL ist fest im gedruckten QR-Code kodiert. Nur das *Ziel* ist dynamisch.
- **Reverse Proxy**: `trust proxy` vertraut standardmäßig Loopback- sowie privaten/Link-lokalen Adressen (`127.0.0.1`, Docker-Bridge-Netze wie `172.17.0.0/12`, `10.0.0.0/8`, `192.168.0.0/16`, …) – deckt damit sowohl den [Betrieb ohne Docker](#ohne-docker) (Proxy nativ auf demselben Host) als auch die typische Docker-Variante ab, bei der ein Reverse Proxy als eigener Container im selben Compose-Netz läuft. Ohne diese Erkennung bliebe das `Secure`-Cookie-Flag trotz TLS-Terminierung durch den Proxy deaktiviert. Nur wenn der Proxy den Traffic über eine öffentliche Adresse einliefert (z. B. Cloudflare Tunnel, externer Load Balancer), zusätzlich `TRUSTED_PROXIES` mit der/den konkreten IP(s)/CIDR(s) setzen (kommagetrennt).
- **Backup**: Die SQLite-Datei läuft im WAL-Modus – ein einfaches `cp` oder ein Datei-Level-Snapshot des Docker-Volumes kann dabei eine inkonsistente Momentaufnahme erwischen (Haupt- und WAL-Datei nicht synchron), was beim Sichern unauffällig aussieht und erst beim Restore auffällt. Das Laufzeit-Image enthält kein `sqlite3`-CLI, aber `better-sqlite3`s eingebaute Online-Backup-API, die auch gegen die laufende Datenbank sicher ist:
  ```bash
  docker exec snar node -e "require('better-sqlite3')('/data/snar.db',{readonly:true}).backup('/data/backup-'+new Date().toISOString().slice(0,10)+'.db')"
  ```
  Danach die erzeugte `backup-*.db` regelmäßig aus dem Volume herausziehen (z. B. `docker cp`) und extern ablegen. Zeitplan, Aufbewahrung und Offsite-Ablage sind bewusst nicht Teil von snar – das hängt zu stark von der jeweiligen Infrastruktur ab (Cron, Portainer, Systemd-Timer, …) und wird dort eingerichtet.

## Projektstruktur

```
src/server.js   Express-App: Auth, CRUD, Redirect, QR-Endpoints
src/db.js       SQLite-Schema, Statements, Slug-Generierung
src/views.js    Server-gerenderte HTML-Templates (inkl. SVG-Chart)
public/         Stylesheet + minimales Client-JS (Dropdowns, Datepicker, Suche, Kopieren)
Dockerfile      node:22-alpine, mehrstufig, läuft als unprivilegierter User
compose.yaml    Deployment mit persistentem Volume, CPU-Limit, Log-Rotation
```

## Mitmachen

Bugs, Fragen, Pull Requests — siehe [CONTRIBUTING.md](CONTRIBUTING.md).

## Lizenz

[AGPL-3.0-or-later](LICENSE) – wer eine geänderte Version über ein Netzwerk anbietet (auch als SaaS), muss den Quellcode dieser Version ebenfalls unter der AGPL verfügbar machen.
