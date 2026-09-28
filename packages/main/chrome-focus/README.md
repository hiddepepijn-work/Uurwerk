# Uurwerk Focus voor Chrome

Zolang de timer op een focustaak loopt, zet deze extensie X en YouTube uit. Wie ze toch
opent, krijgt een pagina "Focus op …". Tabbladen die al open staan, worden omgeleid zodra
de focus begint. Is de taak af of stopt de timer, dan staan de sites binnen een halve
minuut weer aan.

## Installeren

1. Ga in Chrome naar `chrome://extensions`.
2. Zet rechtsboven **Ontwikkelaarsmodus** aan.
3. Klik op **Uitgepakte extensie laden**.
4. Kies deze map: `packages\main\chrome-focus`.

Klaar. De extensie vraagt elke 10 seconden aan Uurwerk of de focus aan staat
(`http://127.0.0.1:47811/focus`); Uurwerk moet dus draaien. Draait Uurwerk niet, dan blokkeert
de extensie niets.

## Andere sites

Welke sites uit gaan, stel je in Uurwerk in: Instellingen → Focus → *Block these sites in
Chrome*. Sites buiten X, Twitter en YouTube krijgen geen focuspagina maar de foutpagina van
Chrome, omdat de extensie alleen voor die drie toestemming vraagt. Wil je er meer, zet ze dan
ook in `host_permissions` in `manifest.json` en klik bij de extensie op het herlaad-icoon.
