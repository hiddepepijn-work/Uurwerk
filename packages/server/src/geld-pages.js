/**
 * Three public pages for the Enable Banking application behind Geld: where the bank sends you
 * back after you confirm in the ABN AMRO app, and the privacy and terms pages the application
 * form asks for. No login: the bank's redirect cannot carry one.
 *
 * The code on the return page is harmless on its own — turning it into access needs the
 * application's private key, which is on the laptop only. The page shows it so you can paste
 * it into Uurwerk; it stores nothing and sends nothing on.
 */

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

function page(title, body) {
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Uurwerk Geld</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main>
<h1>${escape(title)}</h1>
${body}
</main>
</body>
</html>`
}

/** The page for a /geld/… path, or null when it is not one of these. */
export function geldPage(path, url) {
  if (path === '/geld/bank') {
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    if (error) {
      const detail = url.searchParams.get('error_description') ?? error
      return page('Niet gekoppeld', `<p>De bank gaf geen toestemming: ${escape(detail)}.</p><p>Probeer het opnieuw vanuit Uurwerk → Geld → Bank.</p>`)
    }
    if (!code) return page('Bankkoppeling', '<p>Deze pagina is het terugkeeradres van de bank. Start de koppeling vanuit Uurwerk.</p>')
    return page(
      'Bijna klaar',
      `<p>Kopieer deze pagina-link (de adresbalk) of de code hieronder, en plak hem in Uurwerk → Geld → Bank.</p>
<p><label for="code">Code</label><br><input id="code" readonly value="${escape(code)}" size="48"></p>
<p>De code werkt alleen samen met de sleutel op je laptop, en maar één keer.</p>`
    )
  }
  if (path === '/geld/privacy') {
    return page(
      'Privacy',
      `<p>Uurwerk Geld is een persoonlijk budgetoverzicht van één persoon, voor zijn eigen rekeningen.</p>
<p>Rekeninggegevens worden alleen gelezen (nooit betalingen), op het eigen apparaat verwerkt en versleuteld (AES-GCM) tussen de eigen apparaten gesynchroniseerd. Deze server bewaart alleen versleutelde gegevens die hij niet kan lezen. Er wordt niets gedeeld met derden.</p>`
    )
  }
  if (path === '/geld/voorwaarden') {
    return page(
      'Voorwaarden',
      '<p>Uurwerk Geld is uitsluitend voor eigen gebruik door de eigenaar van de gekoppelde rekeningen. Er is geen dienstverlening aan anderen.</p>'
    )
  }
  return null
}
