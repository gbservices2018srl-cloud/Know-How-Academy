# Genera le pagine ufficiali (privacy, cookie, termini) dai testi revisionati dal DPO.
# I testi in *.frag.html vengono dai documenti Word ufficiali (pandoc) e NON vanno modificati a mano:
# per aggiornarli si convertono i nuovi .docx (pandoc file.docx -t html5 --wrap=none -o legal/xxx.frag.html) e si rilancia questo script.
import pathlib, html
QUI = pathlib.Path(__file__).parent
PUB = QUI.parent / 'public'
PUBBLICATO = '13 ottobre 2026'
DOC = {
  'privacy': ('Privacy Policy', 'Come vengono trattati i dati personali su appgestione.it.'),
  'cookie':  ('Cookie Policy', 'Cookie e tecnologie analoghe usati da appgestione.it.'),
  'termini': ('Termini e condizioni d’uso', 'Regole di accesso e utilizzo della webapp appgestione.it.'),
}
LINK = [('privacy', 'Privacy Policy'), ('cookie', 'Cookie Policy'), ('termini', 'Termini e condizioni')]
for k, (titolo, desc) in DOC.items():
    corpo = (QUI / f'{k}.frag.html').read_text(encoding='utf-8')
    altri = ' · '.join(f'<a href="/{x}">{n}</a>' for x, n in LINK if x != k)
    pagina = f'''<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{html.escape(titolo)} · appgestione.it</title>
<meta name="description" content="{html.escape(desc)}">
<link rel="stylesheet" href="/fonts/tosmile.css?f=fira-sans:600,700,800|figtree:400,500,600,700">
<link rel="stylesheet" href="/static/accessi.css?v=3">
<link rel="icon" href="/static/icon.svg">
<style>
.wrap{{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:14px}}
.doc h2{{font-size:20px;margin:18px 0 0}}
.doc p,.doc li{{color:var(--fg);line-height:1.6;margin:6px 0 0}}
.nav-legal{{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:14.5px}}
.nav-legal a{{color:var(--teal-ink);font-weight:600}}
.meta{{color:var(--muted);font-size:14px;border-top:1px solid var(--line);padding-top:14px;margin-top:10px}}
@media print{{.nav-legal,.no-print{{display:none}}}}
</style>
</head>
<body>
<div class="wrap">
  <a class="logo no-print" href="/" aria-label="To Smile"><img src="/static/logo-tosmile.png" alt="To Smile" width="548" height="165" style="width:min(200px,50vw)"></a>
  <h1>{html.escape(titolo)}</h1>
  <div class="rule" aria-hidden="true"></div>
  <article class="doc">
{corpo}
  </article>
  <p class="meta">Documento ufficiale revisionato dal DPO · Ultimo aggiornamento: {PUBBLICATO}</p>
  <nav class="nav-legal" aria-label="Documenti legali">{altri} · <a href="/">Torna alle app</a> · <a href="javascript:print()">Stampa</a></nav>
</div>
</body>
</html>
'''
    (PUB / f'{k}.html').write_text(pagina, encoding='utf-8')
    print('scritto', k)
