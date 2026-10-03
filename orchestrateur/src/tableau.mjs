// Le tableau de bord web des coûts : une page, servie par l'orchestrateur sur
// le réseau interne (port 8091), publiée par Caddy sur usine-tableau.<domaine>.
// Accès protégé par un mot de passe (TABLEAU_MOT_DE_PASSE, dans le .env) ; sans
// mot de passe configuré, la page refuse de s'afficher.
import { createServer } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { bilanMois, bilanProjet, budgetMensuel, budgetProjet, evolution, montant, reglagesCouts } from "./couts.mjs"
import { duree, nomMois } from "./slack-couts.mjs"

const echapper = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const jetons = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n))
const STATUTS = { analyse: "analyse", questions: "questions", plan_a_valider: "plan à valider", creation: "création", fabrication: "fabrication", bloque: "bloqué", livre: "livré", corrections: "corrections", mise_en_production: "mise en production", en_production: "en production", echec: "échec", arrete: "arrêté", abandonne: "abandonné" }

function autorise(req) {
  const attendu = process.env.TABLEAU_MOT_DE_PASSE
  if (!attendu) return false
  const [type, valeur] = String(req.headers.authorization ?? "").split(" ")
  if (type !== "Basic" || !valeur) return false
  const mdp = Buffer.from(valeur, "base64").toString().split(":").slice(1).join(":")
  const a = Buffer.from(mdp)
  const b = Buffer.from(attendu)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Les barres mensuelles (équivalent API et coût réel), en SVG.
function graphique(config, evo) {
  const L = 760
  const H = 240
  const marge = { g: 64, d: 12, h: 16, b: 34 }
  const max = Math.max(...evo.map((e) => Math.max(e.api, e.reel)), 1)
  const pas = (L - marge.g - marge.d) / evo.length
  const larg = Math.min(26, pas / 3)
  const y = (v) => H - marge.b - (v / max) * (H - marge.h - marge.b)
  const graduations = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)
  return `<svg viewBox="0 0 ${L} ${H}" role="img" aria-label="Coûts par mois">
    ${graduations.map((g) => `<line x1="${marge.g}" x2="${L - marge.d}" y1="${y(g)}" y2="${y(g)}" class="grille"/><text x="${marge.g - 8}" y="${y(g) + 4}" text-anchor="end" class="axe">${echapper(montant(config, g, { decimales: 0 }))}</text>`).join("")}
    ${evo.map((e, i) => {
      const x = marge.g + i * pas + pas / 2
      return `<g><title>${echapper(`${nomMois(e.mois)} : ${montant(config, e.api)} équivalent API, ${montant(config, e.reel)} coût réel`)}</title>
        <rect x="${x - larg - 2}" y="${y(e.api)}" width="${larg}" height="${Math.max(0, H - marge.b - y(e.api))}" rx="3" class="api"/>
        <rect x="${x + 2}" y="${y(e.reel)}" width="${larg}" height="${Math.max(0, H - marge.b - y(e.reel))}" rx="3" class="reel"/>
        <text x="${x}" y="${H - 12}" text-anchor="middle" class="axe">${echapper(nomMois(e.mois))}</text></g>`
    }).join("")}
  </svg>`
}

export function page(ctx) {
  const { db } = ctx
  const config = reglagesCouts(db, ctx.config)
  const b = bilanMois(db, config)
  const budget = budgetMensuel(db, config)
  const evo = evolution(db, config, 12)
  const projets = db.prepare("SELECT * FROM projets WHERE statut != 'abandonne' ORDER BY id DESC").all()
  const lignesProjets = projets.map((p) => ({ p, c: bilanProjet(db, config, p.id) }))
  const parModele = {}
  for (const p of b.projets) for (const m of Object.values(p.parModele)) {
    const x = (parModele[m.modele] ??= { modele: m.modele, moteur: m.moteur, api: 0, jetons: 0, appels: 0 })
    x.api += m.api
    x.jetons += m.jetons
    x.appels += m.appels
  }
  const pct = budget > 0 ? Math.min(100, (b.api / budget) * 100) : null
  const calcul = b.projets.reduce((s, p) => s + p.duree_s, 0)
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coûts de l'usine</title><meta http-equiv="refresh" content="300">
<style>
:root { color-scheme: light dark; --fond: #f6f7f9; --carte: #fff; --texte: #1c2330; --doux: #667085; --trait: #e4e7ec; --api: #4f46e5; --reel: #14b8a6; --alerte: #dc2626 }
@media (prefers-color-scheme: dark) { :root { --fond: #0f141b; --carte: #171e28; --texte: #e6e9ef; --doux: #98a2b3; --trait: #2a3342; --api: #818cf8; --reel: #2dd4bf } }
* { box-sizing: border-box } body { margin: 0; background: var(--fond); color: var(--texte); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px } h1 { font-size: 22px; margin: 0 0 4px } h2 { font-size: 16px; margin: 0 0 12px }
.sous { color: var(--doux); margin: 0 0 20px } .grille-cartes { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 16px }
.carte { background: var(--carte); border: 1px solid var(--trait); border-radius: 12px; padding: 16px } .chiffre { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums }
.libelle { color: var(--doux); font-size: 13px } .jauge { height: 8px; background: var(--trait); border-radius: 4px; overflow: hidden; margin-top: 10px } .jauge > div { height: 100%; background: var(--api) } .jauge.pleine > div { background: var(--alerte) }
svg { width: 100%; height: auto } .grille { stroke: var(--trait) } .axe { fill: var(--doux); font-size: 11px } .api { fill: var(--api) } .reel { fill: var(--reel) }
.legende { display: flex; gap: 16px; color: var(--doux); font-size: 13px; margin-top: 6px } .pastille { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px }
.tableau { overflow-x: auto } table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums } th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--trait); white-space: nowrap }
th { color: var(--doux); font-weight: 550; font-size: 12px; text-transform: uppercase; letter-spacing: .03em } td.n, th.n { text-align: right } .section { margin-top: 16px }
code { font-size: 13px } .note { color: var(--doux); font-size: 13px; margin-top: 20px }
</style></head><body><main>
<h1>Coûts de l'usine logicielle</h1>
<p class="sous">${echapper(nomMois(b.mois))} · mis à jour ${echapper(new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" }))}</p>
<div class="grille-cartes">
  <div class="carte"><div class="libelle">Équivalent API, ce mois-ci</div><div class="chiffre">${echapper(montant(config, b.api))}</div>
    ${pct === null ? `<div class="libelle">Pas de budget mensuel</div>` : `<div class="jauge${pct >= 100 ? " pleine" : ""}"><div style="width:${pct.toFixed(1)}%"></div></div><div class="libelle">${Math.round((b.api / budget) * 100)} % du budget de ${echapper(montant(config, budget))}</div>`}</div>
  <div class="carte"><div class="libelle">Coût réel, ce mois-ci</div><div class="chiffre">${echapper(montant(config, b.reel))}</div><div class="libelle">${b.fixe > 0 ? "Abonnements et serveur, plus la passerelle" : "Frais fixes à renseigner (Slack, Réglages des coûts)"}</div></div>
  <div class="carte"><div class="libelle">Jetons, ce mois-ci</div><div class="chiffre">${echapper(jetons(b.jetons))}</div><div class="libelle">${b.appels} appels de modèles</div></div>
  <div class="carte"><div class="libelle">Temps de calcul, ce mois-ci</div><div class="chiffre">${echapper(duree(calcul))}</div><div class="libelle">Agents, analyste et vérificateur</div></div>
</div>
<div class="carte"><h2>Évolution sur 12 mois</h2>${graphique(config, evo)}
  <div class="legende"><span><span class="pastille" style="background:var(--api)"></span>Équivalent API</span><span><span class="pastille" style="background:var(--reel)"></span>Coût réel</span></div></div>
<div class="carte section"><h2>Ce que chaque produit a coûté</h2><div class="tableau"><table>
  <tr><th>Produit</th><th>Statut</th><th class="n">Équiv. API</th><th class="n">Coût réel</th><th class="n">Budget</th><th>Modèles</th><th class="n">Calcul</th><th class="n">Tâches</th><th class="n">Refus</th><th class="n">Corrections</th><th class="n">Escalades</th></tr>
  ${lignesProjets.map(({ p, c }) => {
    const bp = budgetProjet(db, config, p)
    const total = Object.values(c.taches).reduce((s, n) => s + n, 0)
    return `<tr><td><strong>${echapper(p.nom ?? p.prompt.slice(0, 40))}</strong></td><td>${echapper(STATUTS[p.statut] ?? p.statut)}</td>
      <td class="n">${c.mesure ? echapper(montant(config, c.api)) + (c.api_inconnu ? "*" : "") : "non mesuré"}</td><td class="n">${c.mesure ? echapper(montant(config, c.reel)) : "—"}</td>
      <td class="n">${bp > 0 ? `${Math.round((c.api / bp) * 100)} %` : "—"}</td><td>${c.parModele.slice(0, 3).map((m) => `<code>${echapper(m.modele)}</code>`).join(" ")}</td>
      <td class="n">${c.mesure ? echapper(duree(c.calcul_s)) : "—"}</td><td class="n">${c.taches.fusionnee ?? 0}/${total}</td><td class="n">${c.refus}</td><td class="n">${c.corrections}</td><td class="n">${c.escalades}</td></tr>`
  }).join("")}
</table></div></div>
<div class="carte section"><h2>Par modèle, ce mois-ci</h2><div class="tableau"><table>
  <tr><th>Modèle</th><th>Moteur</th><th class="n">Équiv. API</th><th class="n">Jetons</th><th class="n">Appels</th></tr>
  ${Object.values(parModele).sort((a, c) => c.api - a.api || c.jetons - a.jetons).map((m) => `<tr><td><code>${echapper(m.modele)}</code></td><td>${echapper(m.moteur)}</td><td class="n">${echapper(montant(config, m.api))}</td><td class="n">${echapper(jetons(m.jetons))}</td><td class="n">${m.appels}</td></tr>`).join("") || `<tr><td colspan="5">Aucune consommation ce mois-ci.</td></tr>`}
</table></div></div>
<p class="note"><strong>Équivalent API</strong> : ce que les appels coûteraient avec des clés payantes (prix publics), pour comparer les produits entre eux. <strong>Coût réel</strong> : ce que tu paies, c'est-à-dire les abonnements et le serveur répartis au prorata de l'usage, plus la passerelle. * : une partie des jetons n'a pas de prix connu (Codex). Les projets antérieurs au 3 octobre 2026 ne sont pas mesurés.</p>
</main></body></html>`
}

export function demarrerTableau(ctx, port = 8091) {
  createServer((req, res) => {
    if (!process.env.TABLEAU_MOT_DE_PASSE) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" })
      return res.end("Tableau de bord non configuré : TABLEAU_MOT_DE_PASSE manque dans le .env de l'usine.")
    }
    if (!autorise(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Usine logicielle", charset="UTF-8"', "content-type": "text/plain; charset=utf-8" })
      return res.end("Accès réservé.")
    }
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" })
      res.end(page(ctx))
    } catch (error) {
      console.error("Tableau de bord :", error)
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
      res.end("Erreur du tableau de bord.")
    }
  }).listen(port, "0.0.0.0", () => console.log(`Tableau de bord des coûts sur le port ${port}.`))
}
