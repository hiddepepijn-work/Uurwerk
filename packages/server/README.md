# Uurwerk server

Eén klein Node-proces op de VPS. Het doet drie dingen:

1. **innemen** wat de desktop-app publiceert — `PUT`/`DELETE` met een bearer-token, precies
   het contract dat `packages/main/src/publisher.ts` al spreekt;
2. **tonen** wat er gedeeld is, achter een login, aan twee mensen: de stagebegeleider en de
   docent. Ieder ziet alleen wat voor hém of haar is klaargezet;
3. **beheren** — jouw eigen account (`admin`): meekijken door hun ogen, accounts maken en
   wachtwoorden opnieuw zetten, sessies beëindigen, en als het moet een dag met één knop
   offline halen.

Er wordt hier niets berekend en niets besloten. De app bepaalt vóór het uploaden wat naar
buiten mag; deze server bewaakt nog één regel: een lezer krijgt alleen bestanden die in
*zijn eigen* index staan (`src/library.js`). Alles daarbuiten is 404, ook als het bestaat.

Geen dependencies. Node 20 of nieuwer, verder niets.

## Wat de rollen zien

| | Stagebegeleider | Docent | Beheer |
| --- | --- | --- | --- |
| Dagen | `index-supervisor.json` | `index-teacher.json` | kiest met `?als=` welke van de twee |
| Taaknamen | zichtbaar als gebied **en** project delen met de begeleider | idem, met de docent-toestemming | wat de gekozen rol ziet |
| Overige taken | `Overig werk`, mét minuten | `Overig werk`, mét minuten | idem |
| Screenshots / timelapse | alleen goedgekeurde frames | dezelfde frames | idem |
| Live-kaart (`Nu`) | ja | nee — die is opgebouwd onder de toestemming van de begeleider | alleen als begeleider |
| Beheerpagina | nee | nee | ja |

De twee toestemmingen staan per gebied in de app (`defaultShareSupervisor`,
`defaultShareTeacher`) en per project (`shareable`, kan alleen smaller maken, nooit ruimer).
De app zet elke dag twee keer klaar, één keer per publiek.

## Installeren op de VPS

```bash
# 1. gebruiker en mappen
sudo useradd --system --home /var/lib/uurwerk --shell /usr/sbin/nologin uurwerk
sudo mkdir -p /opt/uurwerk-server /var/lib/uurwerk
sudo chown -R uurwerk:uurwerk /var/lib/uurwerk

# 2. code erheen (alleen deze map is nodig)
rsync -av --delete packages/server/ root@VPS:/opt/uurwerk-server/

# 3. token — hetzelfde token als in de app, Instellingen -> Publiceren
printf 'UURWERK_PUBLISH_TOKEN=%s\n' "$(openssl rand -hex 32)" | sudo tee /etc/uurwerk.env
sudo chmod 640 /etc/uurwerk.env

# 4. service
sudo cp /opt/uurwerk-server/deploy/uurwerk-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now uurwerk-server
sudo systemctl status uurwerk-server

# 5. TLS ervoor
sudo cp /opt/uurwerk-server/deploy/Caddyfile.example /etc/caddy/Caddyfile   # hostnaam aanpassen
sudo systemctl reload caddy
```

### De accounts

Eerst die van jou, op de server zelf. Daarna kan de rest vanaf de site.

```bash
sudo -u uurwerk UURWERK_DATA_DIR=/var/lib/uurwerk \
  node /opt/uurwerk-server/bin/uurwerk-users.js add hidde admin
```

Begeleider en docent kun je ook met de hand maken:

```bash
sudo -u uurwerk UURWERK_DATA_DIR=/var/lib/uurwerk \
  node /opt/uurwerk-server/bin/uurwerk-users.js add begeleider supervisor
sudo -u uurwerk UURWERK_DATA_DIR=/var/lib/uurwerk \
  node /opt/uurwerk-server/bin/uurwerk-users.js add docent teacher
```

Het wachtwoord wordt gevraagd met de echo uit (minimaal 12 tekens) en opgeslagen als
scrypt-hash in `/var/lib/uurwerk/users.json`, mode 0600. `list`, `passwd` en `remove` doen
wat ze zeggen. Er is geen registratie- of resetpagina; een vergeten wachtwoord zet je hier
of op de beheerpagina opnieuw.

Zolang er nog geen enkel account is, toont de site precies dat eerste commando in plaats van
een loginscherm. Er is geen pagina die het eerste beheeraccount kan maken — die zou het ook
kunnen maken voor wie de server eerder vindt dan jij.

### In de app

Instellingen → Publiceren:

- **URL**: `https://uurwerk.jouwdomein.nl/publish`
- **Token**: dezelfde waarde als `UURWERK_PUBLISH_TOKEN`
- Publiceren aanzetten.

Publiceren blijft een handeling per dag: vinkjes voor wat mee mag, frames stuk voor stuk
goedkeuren, dan pas Publiceren. Ontpubliceren haalt de bestanden echt weg en de dag
verdwijnt uit beide indexen.

## Beheer

Inloggen als `admin` komt uit op **/beheer**:

- **Meekijken** — `/?als=supervisor` en `/?als=teacher` tonen exact wat zij zien, inclusief
  welke taaknamen gemaskeerd zijn. De bestandstoegang gaat mee: als docent krijg je 404 op
  een screenshot die alleen de begeleider mag zien.
- **Accounts** — toevoegen, rol wijzigen, wachtwoord opnieuw zetten (zelfde naam invullen).
  Een nieuw wachtwoord logt die persoon overal uit. Je eigen account verwijderen kan niet, en
  de laatste beheerder ook niet — anders is de weg terug een SSH-sessie.
- **Online** — welke dagen er staan, voor wie, met hoeveel bestanden. De knop *Offline halen*
  is de noodknop: dag uit beide indexen, bestanden van de schijf. De normale route blijft
  Ontpubliceren in de app; de app weet van deze actie niets, dus verwijdert zijn eigen
  Ontpubliceren daarna namen die er al niet meer zijn — dat geeft geen fout.
- **Ingelogd** — wie er een geldige sessie heeft, met een knop om die te beëindigen.
- **Server** — aantal bestanden, schijfgebruik en tijdstip van de laatste upload. Daarmee is
  "is het publiceren aangekomen" te beantwoorden zonder SSH.

Elk formulier daar draagt een token van de sessie. Cookies staan al op `SameSite=Strict` en
de CSP laat alleen `form-action 'self'` toe; het token is het derde slot op de deuren die
iets weggooien.

## Instellingen

| Variabele | Standaard | Betekenis |
| --- | --- | --- |
| `UURWERK_PUBLISH_TOKEN` | — | Verplicht. Minimaal 24 tekens, anders start hij niet. |
| `UURWERK_DATA_DIR` | `./data` | `blobs/`, `users.json`, `sessions.json`. |
| `UURWERK_HOST` / `UURWERK_PORT` | `127.0.0.1` / `8787` | Alleen localhost; TLS staat ervoor. |
| `UURWERK_SESSION_HOURS` | `12` | Hoe lang een login geldig blijft. Wordt niet verlengd. |
| `UURWERK_TRUST_PROXY` | uit | Leest het adres uit `X-Forwarded-For`. Alleen aan achter je eigen proxy. |
| `UURWERK_INSECURE_COOKIES` | uit | Alleen voor testen op localhost zonder TLS. |
| `UURWERK_TITLE` | `Uurwerk` | Naam boven de pagina. |

## Lokaal proberen

```bash
cd packages/server
export UURWERK_DATA_DIR=./data UURWERK_PUBLISH_TOKEN=$(openssl rand -hex 32) UURWERK_INSECURE_COOKIES=1
node bin/uurwerk-users.js add hidde admin --password "een-lang-wachtwoord"
node src/server.js
```

## Wat er bewust níét in zit

- **Geen JavaScript op de pagina's.** De CSP verbiedt het; er valt niets te misbruiken.
- **Geen registratie, geen reset per e-mail, geen "onthoud mij".** Het eerste beheeraccount
  maak je op de server; de rest gaat via de beheerpagina.
- **Geen directe bestandstoegang.** `/bestand/<naam>` gaat eerst langs de index van de
  ingelogde rol. Een onraadbare naam is geen toegangsregel.
- **Geen database.** JSON en bytes op schijf. Wat er staat, is precies wat de app heeft
  geüpload, en `rm -rf /var/lib/uurwerk/blobs` is een complete wisser.
