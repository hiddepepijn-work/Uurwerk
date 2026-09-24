/**
 * The pages a supervisor or a teacher sees.
 *
 * Written in Dutch, because the two people reading them are a Dutch internship supervisor
 * and a Dutch teacher. Kept plain on purpose: this is a report, not an app. There is no
 * JavaScript on any page at all — the content security policy forbids it — so there is
 * nothing on this site that can be talked into doing something.
 *
 * Every value is escaped on the way in. The data comes from the desktop app, but "our own
 * app produced it" is not a reason to trust a string that ends up inside a tag.
 */

import { escape } from './http.js'
import { ROLE_LABELS } from './users.js'

const MINUTES = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0u 00m'
  const hours = Math.floor(value / 60)
  const minutes = Math.round(value % 60)
  return `${hours}u ${String(minutes).padStart(2, '0')}m`
}

const WEEKDAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag']
const MONTHS = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december'
]

/** `maandag 22 september 2026`, from an ISO date, without dragging a timezone into it. */
export function longDate(iso) {
  const [year, month, day] = String(iso).split('-').map(Number)
  if (!year || !month || !day) return escape(iso)
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
  return `${weekday} ${day} ${MONTHS[month - 1]} ${year}`
}

/** `?als=teacher` while an admin is looking through a reader's eyes, and nothing otherwise. */
const asSuffix = (user, viewing) =>
  user?.role === 'admin' && viewing ? `?als=${encodeURIComponent(viewing)}` : ''

function layout({ title, siteTitle, body, user, viewing }) {
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(title)} — ${escape(siteTitle)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header>
  <a class="brand" href="/">${escape(siteTitle)}</a>
  ${user?.role === 'admin' ? '<a class="navlink" href="/beheer">Beheer</a>' : ''}
  ${
    user
      ? `<span class="who">${escape(user.username)} · ${escape(ROLE_LABELS[user.role] ?? user.role)}</span>
         <form method="post" action="/uitloggen"><button type="submit">Uitloggen</button></form>`
      : ''
  }
</header>
${
  user?.role === 'admin' && viewing
    ? `<div class="asbar">
    Je kijkt mee als <strong>${escape(ROLE_LABELS[viewing] ?? viewing)}</strong>.
    <a href="/?als=supervisor">Stagebegeleider</a>
    <a href="/?als=teacher">Docent</a>
  </div>`
    : ''
}
<main>
${body}
</main>
</body>
</html>`
}

export function loginPage({ siteTitle, problem }) {
  return layout({
    title: 'Inloggen',
    siteTitle,
    body: `
<section class="card narrow">
  <h1>Inloggen</h1>
  <p class="dim">Alleen voor de stagebegeleider, de docent en de beheerder.</p>
  ${problem ? `<p class="warn">${escape(problem)}</p>` : ''}
  <form method="post" action="/inloggen">
    <label>Gebruikersnaam<input name="username" autocomplete="username" required autofocus></label>
    <label>Wachtwoord<input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit" class="primary">Inloggen</button>
  </form>
</section>`
  })
}

/**
 * The overview: the days that have been shared with this reader, newest first.
 *
 * A day that is not in this list was never published, or has been withdrawn. Both look the
 * same from here, and that is deliberate — the absence of a day is not information.
 */
export function overviewPage({ siteTitle, user, days, snapshot, viewing }) {
  // An admin looking through somebody's eyes keeps looking through them when they click a
  // day; without this the link drops back to the supervisor's view halfway through a check.
  const as = asSuffix(user, viewing)
  const rows = days
    .map(
      (day) => `
  <li>
    <a href="/dag/${escape(day.date)}${as}">
      <span class="date">${longDate(day.date)}</span>
      <span class="numbers">
        ${day.trackedMin !== undefined ? `<span>${MINUTES(day.trackedMin)} stage</span>` : ''}
        ${day.completedTasks !== undefined ? `<span>${escape(day.completedTasks)}/${escape(day.totalTasks)} taken af</span>` : ''}
        ${day.screenshots?.length ? `<span>${day.screenshots.length} beeld${day.screenshots.length === 1 ? '' : 'en'}</span>` : ''}
      </span>
    </a>
  </li>`
    )
    .join('')

  return layout({
    title: 'Overzicht',
    siteTitle,
    user,
    viewing,
    body: `
${snapshot ? liveCard(snapshot) : ''}
<section class="card">
  <h1>Gedeelde dagen</h1>
  ${
    days.length === 0
      ? '<p class="dim">Er is nog niets met je gedeeld. Zodra een dag gedeeld wordt, verschijnt die hier.</p>'
      : `<ul class="days">${rows}</ul>`
  }
</section>`
  })
}

/** The live card. Supervisor only: it is built against the supervisor's consent. */
function liveCard(snapshot) {
  return `
<section class="card live">
  <h2>Nu</h2>
  <p class="status">${snapshot.tracking ? 'Aan het werk' : 'Niet aan het werk'}${
    snapshot.tracking && snapshot.currentTask ? ` — ${escape(snapshot.currentTask)}` : ''
  }</p>
  <dl>
    <div><dt>Vandaag</dt><dd>${MINUTES(snapshot.todayStageMin)}</dd></div>
    <div><dt>Deze week</dt><dd>${MINUTES(snapshot.weekStageMin)}</dd></div>
    <div><dt>Gepland deze week</dt><dd>${MINUTES(snapshot.weekPlannedMin)}</dd></div>
    <div><dt>Open taken</dt><dd>${escape(snapshot.openTasks ?? 0)}</dd></div>
  </dl>
</section>`
}

export function dayPage({ siteTitle, user, day, viewing }) {
  const activities = (day.activities ?? [])
    .map(
      (activity) =>
        `<li><span>${escape(activity.title)}</span><span class="dim">${MINUTES(activity.minutes)}</span></li>`
    )
    .join('')

  const images = (day.screenshots ?? [])
    .map(
      (name) =>
        `<a href="/bestand/${escape(name)}"><img src="/bestand/${escape(name)}" alt="" loading="lazy"></a>`
    )
    .join('')

  return layout({
    title: longDate(day.date),
    siteTitle,
    user,
    viewing,
    body: `
<p class="back"><a href="/${asSuffix(user, viewing)}">← Alle dagen</a></p>
<section class="card">
  <h1>${longDate(day.date)}</h1>

  ${
    day.trackedMin !== undefined
      ? `<dl>
    <div><dt>Stage-uren</dt><dd>${MINUTES(day.trackedMin)}</dd></div>
    <div><dt>Geconcentreerd</dt><dd>${MINUTES(day.focusMin)}</dd></div>
    <div><dt>Werksessies</dt><dd>${escape(day.sessionCount ?? 0)}</dd></div>
  </dl>`
      : ''
  }

  ${
    day.completedTasks !== undefined
      ? `<p>${escape(day.completedTasks)} van ${escape(day.totalTasks)} taken afgerond.</p>`
      : ''
  }

  ${activities ? `<h2>Waar de tijd naartoe ging</h2><ul class="activities">${activities}</ul>` : ''}
  ${day.summary ? `<h2>Toelichting</h2><p class="summary">${escape(day.summary)}</p>` : ''}
  ${images ? `<h2>Beeld</h2><div class="shots">${images}</div>` : ''}
  ${
    day.timelapse
      ? `<h2>Timelapse</h2><video controls preload="none" src="/bestand/${escape(day.timelapse)}"></video>`
      : ''
  }
</section>`
  })
}

/**
 * The admin page: accounts, what is online, and who is looking.
 *
 * Every button on it does something that cannot be undone from a browser, so every form
 * carries the session's own token and every destructive one says what it is going to do
 * before it does it. There is no confirmation dialog, because a dialog needs JavaScript and
 * this site has none — the wording of the button is the confirmation.
 */
export function adminPage({ siteTitle, user, accounts, days, sessions, stats, notice, problem }) {
  const token = `<input type="hidden" name="csrf" value="${escape(user.csrf)}">`

  const accountRows = accounts
    .map(
      (account) => `
    <tr>
      <td>${escape(account.username)}</td>
      <td class="dim">${escape(ROLE_LABELS[account.role] ?? account.role)}</td>
      <td class="right">
        <form method="post" action="/beheer/account-verwijderen">
          ${token}
          <input type="hidden" name="username" value="${escape(account.username)}">
          <button type="submit">Verwijderen</button>
        </form>
      </td>
    </tr>`
    )
    .join('')

  const dayRows = days
    .map(
      (day) => `
    <tr>
      <td><a href="/dag/${escape(day.date)}?als=${escape(day.roles[0] ?? 'supervisor')}">${longDate(day.date)}</a></td>
      <td class="dim">${day.roles.map((role) => escape(ROLE_LABELS[role] ?? role)).join(', ')}</td>
      <td class="dim">${day.files > 0 ? `${day.files} bestand${day.files === 1 ? '' : 'en'}` : '—'}</td>
      <td class="right">
        <form method="post" action="/beheer/dag-intrekken">
          ${token}
          <input type="hidden" name="date" value="${escape(day.date)}">
          <button type="submit">Offline halen</button>
        </form>
      </td>
    </tr>`
    )
    .join('')

  const sessionRows = sessions
    .map(
      (session) => `
    <tr>
      <td>${escape(session.username)}</td>
      <td class="dim">${escape(ROLE_LABELS[session.role] ?? session.role)}</td>
      <td class="dim">tot ${new Date(session.expiresAt).toLocaleString('nl-NL')}</td>
      <td class="right">
        <form method="post" action="/beheer/sessie-beeindigen">
          ${token}
          <input type="hidden" name="id" value="${escape(session.id)}">
          <button type="submit">Uitloggen</button>
        </form>
      </td>
    </tr>`
    )
    .join('')

  return layout({
    title: 'Beheer',
    siteTitle,
    user,
    body: `
${notice ? `<p class="notice">${escape(notice)}</p>` : ''}
${problem ? `<p class="warn">${escape(problem)}</p>` : ''}

<section class="card">
  <h1>Meekijken</h1>
  <p class="dim">Precies wat zij zien, niets meer. Zo kun je het controleren vóór een gesprek.</p>
  <p class="actions">
    <a class="button" href="/?als=supervisor">Als stagebegeleider</a>
    <a class="button" href="/?als=teacher">Als docent</a>
  </p>
</section>

<section class="card">
  <h2>Accounts</h2>
  <table>${accountRows || '<tr><td class="dim">Nog geen accounts.</td></tr>'}</table>

  <h3>Toevoegen of wachtwoord opnieuw zetten</h3>
  <p class="dim">Een bestaande naam krijgt het nieuwe wachtwoord, en wordt overal uitgelogd.</p>
  <form method="post" action="/beheer/account" class="row">
    ${token}
    <label>Naam<input name="username" required autocomplete="off"></label>
    <label>Rol
      <select name="role">
        <option value="supervisor">Stagebegeleider</option>
        <option value="teacher">Docent</option>
        <option value="admin">Beheer</option>
      </select>
    </label>
    <label>Wachtwoord<input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
    <button type="submit" class="primary">Opslaan</button>
  </form>
</section>

<section class="card">
  <h2>Online</h2>
  <p class="dim">
    Normaal haal je een dag weg met Ontpubliceren in de app. Dit is de noodknop: de dag gaat
    uit beide overzichten en de bestanden gaan van de schijf.
  </p>
  <table>${dayRows || '<tr><td class="dim">Er staat niets online.</td></tr>'}</table>
</section>

<section class="card">
  <h2>Ingelogd</h2>
  <table>${sessionRows || '<tr><td class="dim">Niemand.</td></tr>'}</table>
</section>

<section class="card">
  <h2>Server</h2>
  <dl>
    <div><dt>Bestanden</dt><dd>${escape(stats.files)}</dd></div>
    <div><dt>Schijf</dt><dd>${(stats.bytes / 1048576).toFixed(1)} MB</dd></div>
    <div><dt>Laatste upload</dt><dd>${
      stats.newest ? new Date(stats.newest).toLocaleString('nl-NL') : '—'
    }</dd></div>
  </dl>
</section>`
  })
}

/**
 * The very first start: no accounts yet, so there is nothing to log in to.
 *
 * It says what to type rather than offering a form. A page that can make the first admin is
 * a page that can make one for anybody who finds the server before you do.
 */
export function setupPage({ siteTitle }) {
  return layout({
    title: 'Nog niets ingesteld',
    siteTitle,
    body: `
<section class="card narrow">
  <h1>Nog geen accounts</h1>
  <p class="dim">Maak het eerste beheeraccount op de server zelf:</p>
  <pre>node bin/uurwerk-users.js add hidde admin</pre>
  <p class="dim">Daarna kun je de rest vanaf deze site doen.</p>
</section>`
  })
}

export function messagePage({ siteTitle, title, message, user }) {
  return layout({
    title,
    siteTitle,
    user,
    body: `<section class="card narrow"><h1>${escape(title)}</h1><p class="dim">${escape(message)}</p></section>`
  })
}

export const STYLESHEET = `
:root {
  color-scheme: light dark;
  --bg: #0f1115; --card: #161a21; --border: #262c36;
  --text: #e6e9ef; --dim: #9aa4b2; --accent: #22c55e; --warn: #f59e0b;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f6f7f9; --card: #ffffff; --border: #e3e6ea; --text: #15181d; --dim: #5b6472; }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 20px; border-bottom: 1px solid var(--border);
}
.brand { font-weight: 600; color: var(--text); text-decoration: none; }
.who { margin-left: auto; color: var(--dim); font-size: 13px; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: 12px; padding: 20px; margin-bottom: 18px;
}
.card.narrow { max-width: 380px; margin: 48px auto; }
h1 { font-size: 20px; margin: 0 0 6px; }
h2 { font-size: 15px; margin: 22px 0 8px; }
p { margin: 0 0 12px; }
.dim { color: var(--dim); }
.warn { color: var(--warn); }
label { display: block; margin: 0 0 12px; font-size: 13px; color: var(--dim); }
input {
  display: block; width: 100%; margin-top: 4px; padding: 9px 10px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text); font: inherit;
}
button {
  padding: 8px 14px; border: 1px solid var(--border); border-radius: 8px;
  background: transparent; color: var(--text); font: inherit; cursor: pointer;
}
button.primary { background: var(--accent); border-color: var(--accent); color: #06210f; font-weight: 600; }
header form { margin: 0; }
ul { list-style: none; margin: 0; padding: 0; }
.days li a {
  display: flex; justify-content: space-between; gap: 12px; padding: 11px 2px;
  border-bottom: 1px solid var(--border); color: var(--text); text-decoration: none;
}
.days li:last-child a { border-bottom: none; }
.days .numbers { color: var(--dim); font-size: 13px; display: flex; gap: 14px; }
.activities li { display: flex; justify-content: space-between; padding: 5px 0; }
dl { display: flex; flex-wrap: wrap; gap: 18px; margin: 10px 0 16px; }
dt { color: var(--dim); font-size: 12px; }
dd { margin: 2px 0 0; font-size: 17px; font-variant-numeric: tabular-nums; }
.summary { white-space: pre-wrap; }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.shots img { width: 100%; border-radius: 8px; border: 1px solid var(--border); display: block; }
video { width: 100%; border-radius: 8px; border: 1px solid var(--border); }
.back { font-size: 13px; }
.back a, .days li a:hover { color: var(--accent); }
.live .status { font-weight: 600; }

/* ----------------------------------------------------------------- beheer */
.navlink { color: var(--dim); text-decoration: none; font-size: 13px; }
.navlink:hover { color: var(--accent); }
.asbar {
  display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  padding: 8px 20px; font-size: 13px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-bottom: 1px solid var(--border);
}
.asbar a { color: var(--accent); }
.notice { color: var(--accent); }
h3 { font-size: 13px; margin: 20px 0 6px; color: var(--dim); }
table { width: 100%; border-collapse: collapse; }
td { padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr:last-child td { border-bottom: none; }
td.right { text-align: right; width: 1%; white-space: nowrap; }
td form { margin: 0; }
td a { color: var(--text); }
td a:hover { color: var(--accent); }
form.row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
form.row label { flex: 1 1 140px; margin: 0; }
select {
  display: block; width: 100%; margin-top: 4px; padding: 9px 10px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text); font: inherit;
}
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
a.button {
  padding: 8px 14px; border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); text-decoration: none; font-size: 14px;
}
a.button:hover { border-color: var(--accent); color: var(--accent); }
pre {
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px; overflow-x: auto; font-size: 13px;
}
@media (max-width: 520px) {
  .days li a { flex-direction: column; gap: 4px; }
  form.row { flex-direction: column; align-items: stretch; }
}
`
