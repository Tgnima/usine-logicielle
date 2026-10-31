// La console de l'usine, côté navigateur. Sans framework ni étape de build :
// un routeur sur l'ancre (#/…), des vues rendues en HTML échappé, une
// délégation d'évènements (data-action), un rafraîchissement régulier.

// --- Outils ------------------------------------------------------------------------
const BRUT = Symbol("brut")
const brut = (texte) => ({ [BRUT]: String(texte) })
const echapper = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const valeur = (v) => (v === null || v === undefined || v === false ? "" : Array.isArray(v) ? v.map(valeur).join("") : v[BRUT] !== undefined ? v[BRUT] : echapper(v))
// html`…${x}…` : chaque valeur est échappée, sauf ce qui vient déjà de html`` (ou de brut()).
function html(chaines, ...valeurs) {
  return brut(chaines.reduce((s, c, i) => s + c + (i < valeurs.length ? valeur(valeurs[i]) : ""), ""))
}
const $ = (sel, racine = document) => racine.querySelector(sel)
// Les messages de l'usine sont écrits pour Slack : on retire les codes d'émojis et les accents graves.
const nettoyer = (t) => String(t ?? "").replace(/:[a-z0-9_+-]+:\s*/g, "").replace(/`/g, "").replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2").replace(/\*([^*\n]+)\*/g, "$1")

async function api(methode, chemin, corps) {
  const r = await fetch(`/api/${chemin}`, {
    method: methode,
    headers: corps !== undefined ? { "content-type": "application/json" } : {},
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
    credentials: "same-origin",
    redirect: "manual",
  }).catch(() => {
    throw new Error("La console ne répond pas. Vérifie ta connexion, puis recharge la page.")
  })
  if (r.type === "opaqueredirect" || r.status === 0) throw new Error("Ta session a expiré : recharge la page (Ctrl R) pour te reconnecter.")
  const json = await r.json().catch(() => ({}))
  if (r.status === 401 || r.status === 403) throw new Error(json.erreur ?? "Session expirée : recharge la page pour te reconnecter.")
  if (!r.ok) throw new Error(json.erreur ?? `Erreur ${r.status}`)
  return json
}

const STATUTS = {
  analyse: ["Analyse", "bleu"], questions: ["Questions", "orange"], plan_a_valider: ["Plan à valider", "orange"],
  creation: ["Préparation", "bleu"], fabrication: ["Construction", "bleu"], reorientation: ["Réorientation", "orange"], corrections: ["Corrections", "bleu"],
  bloque: ["Bloqué", "rouge"], livre: ["Prêt à mettre en ligne", "orange"], mise_en_production: ["Mise en ligne", "bleu"],
  en_production: ["En ligne", "vert"], echec: ["Échec", "rouge"], arrete: ["Arrêté", ""], abandonne: ["Abandonné", ""],
}
const BRIQUES = { webapp: "Application web", site: "Site vitrine", api: "Connecteur (API)", pwa: "Application mobile" }
const badgeStatut = (s) => html`<span class="badge ${(STATUTS[s] ?? ["", ""])[1]}">${(STATUTS[s] ?? [s])[0]}</span>`

// La ligne de vie d'un projet : cinq phases (la phase et son état viennent du serveur).
const PHASES = ["Comprendre", "Planifier", "Fabriquer", "Recette", "En ligne"]
function ligneDeVie(p) {
  const ph = p.phase
  if (!ph) return ""
  const a = p.avancement
  const pctFab = a?.total ? Math.round((a.finies / a.total) * 100) : 0
  const fini = p.statut === "en_production"
  return html`<ol class="vie" aria-label="Où en est le projet">${PHASES.map((nom, i) => {
    const cls = i < ph.index || (fini && i === ph.index) ? "fait" : i === ph.index ? "courant" : ""
    const remplissage = i === ph.index && !fini ? (i === 2 ? pctFab : 50) : null
    return html`<li class="${cls}" ${i === ph.index ? brut('aria-current="step"') : ""}><i style="${remplissage !== null ? `--rempli:${remplissage}%` : ""}"></i>${nom}${i === 2 && i === ph.index && p.lots ? html`<small>lot ${Math.min(p.lots, (p.lot_livre ?? 0) + 1)} sur ${p.lots}</small>` : ""}</li>`
  })}</ol>`
}
// La pastille qui compte : l'usine attend-elle une décision ?
const ATTENTES = { decision: "Ta décision est attendue", questions: "L'analyste attend tes réponses", plan: "Le plan attend ta validation", livre: "Prêt à mettre en ligne", echec: "À relancer" }
const pastilleAttente = (p) => (p.attend?.oui ? html`<span class="badge orange">${ATTENTES[p.attend.quoi] ?? "À traiter"}</span>` : "")
const heure = (le) => {
  const d = new Date(String(le).replace(" ", "T") + (String(le).includes("Z") ? "" : "Z"))
  return isNaN(d) ? "" : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
}
const ICONES = {
  plan: html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  livre: html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>`,
  decision: html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>`,
  questions: html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01"/></svg>`,
}

// --- État ----------------------------------------------------------------------------
const etat = {
  route: { vue: "accueil" },
  resume: null,
  projet: null,
  sante: null,
  acces: null,
  reglages: null,
  premiersPas: null, // les étapes restantes pour que l'usine soit prête
  fournisseurs: null, // Réglages : les fournisseurs d'IA (jamais une valeur secrète)
  chatgpt: null, // la connexion ChatGPT en cours : { etat, url, code }
  onglet: null, // null : « En direct » si une tâche tourne, sinon le journal
  brique: "webapp",
  message: null, // { type: "ok" | "erreur" | "info", texte }
  confirmer: null, // action en attente de confirmation
  occupe: false, // une action est en cours : pas de double envoi, pas de rafraîchissement
  numero: 0, // numéro de chargement : une réponse périmée est ignorée
  detailsOuvert: false,
  reorienterOuvert: false, // le volet « Changer de direction » d'un projet en fabrication
  filtre: "actifs", // la liste des projets : actifs | production | archives | tous
  pieces: [], // les fichiers choisis pour une nouvelle demande
  estimation: null,
  historique: null,
  histoFiltre: { projet: "", type: "" },
  vus: null, // les éléments « à traiter » déjà connus (notifications)
  cleCreee: null,
  invitation: null,
  planModifie: false,
  depart: "zero", // nouveau projet : zero | depot (reprendre un dépôt existant)
  personas: null,
  persona: null,
  personaScenarios: null, // les scénarios en cours d'édition (ajout, retrait)
  questions: null, // les réponses en cours aux questions de l'analyste : { projet, i, reponses }
  planVue: "lecture", // le plan à valider : lecture (par défaut) | edition
  prodReglages: false, // la mise en ligne : les réglages dépliés
  produit: { projet: null, lot: null, i: 0 }, // le volet Produit : le lot et la capture affichés
  fenetre: null, // la fenêtre ouverte : public | inviter | budget | integration-<id>
  invites: [], // les adresses déjà saisies dans l'invitation, en pastilles
  personaSection: null, // la section de la fiche d'un public en cours de modification
  personaChoisi: null, // le public choisi dans la saisie de l'accueil
  santeLe: 0, // l'heure du dernier bilan de santé chargé (la pastille du haut)
  filtreConnecteurs: "", // la famille de connecteurs affichée
  departPublic: null, // le point de départ choisi pour créer un public (decrire, documents, github, fiche)
  jetons: null, // les jetons « depuis ma machine »
  jetonCree: null, // le jeton qui vient d'être créé, montré une seule fois
}

// Les réglages ont un sous-menu (Base44, Unify) : l'équipe, l'utilisation et l'historique y vivent.
const SECTIONS_REGLAGES = [
  ["integrations", "Intégrations", "IA, GitHub, Slack"],
  ["connecteurs", "Connecteurs", "Des outils pour les IA"],
  ["equipe", "Équipe", "Qui a accès"],
  ["utilisation", "Utilisation", "Dépenses et budget"],
  ["etat", "État de l'usine", "Services et mises à jour"],
  ["historique", "Historique", "Qui a fait quoi"],
  ["regles", "Règles de l'usine", "Qui décide quoi"],
]

function lireRoute() {
  // Un retour de GitHub (#/reglages?github=ok&message=…) : le message, puis une adresse propre.
  const retour = location.hash.match(/^#\/reglages\?(.*)$/)
  if (retour) {
    const p = new URLSearchParams(retour[1])
    if (p.get("message")) etat.message = { type: p.get("github") === "ok" ? "ok" : "erreur", texte: p.get("message") }
    history.replaceState(null, "", "#/reglages")
  }
  const h = location.hash.replace(/^#/, "") || "/"
  const m = h.match(/^\/projets\/(\d+)/)
  if (m) return { vue: "projet", id: Number(m[1]) }
  // « Nouveau projet » n'est plus une page : la saisie de l'accueil prend le focus.
  if (h.startsWith("/nouveau")) return { vue: "accueil", nouveau: true }
  if (h === "/projets") return { vue: "projets" }
  const mp = h.match(/^\/personas\/(\d+)/)
  if (mp) return { vue: "persona", id: Number(mp[1]) }
  if (h.startsWith("/personas")) return { vue: "personas" }
  const r = h.match(/^\/reglages\/([a-z]+)/)
  if (r && SECTIONS_REGLAGES.some(([id]) => id === r[1])) return { vue: "reglages", section: r[1] }
  // Les anciennes adresses mènent à leur nouvelle place.
  if (h.startsWith("/sante")) return { vue: "reglages", section: "utilisation" }
  if (h.startsWith("/acces")) return { vue: "reglages", section: "equipe" }
  if (h.startsWith("/historique")) return { vue: "reglages", section: "historique" }
  if (h.startsWith("/reglages")) return { vue: "reglages", section: "integrations" }
  const d = h.match(/^\/demarrer(?:\/([a-z]+))?/)
  if (d) return { vue: "demarrer", etape: d[1] ?? null }
  return { vue: "accueil" }
}

// --- Vues ----------------------------------------------------------------------------
// L'état de l'usine tient dans une pastille ; un bandeau n'apparaît qu'en cas de panne (Mintlify).
function pastilleEtat() {
  const s = etat.sante
  if (!s) return ""
  const soucis = s.composants.filter((c) => c.etat !== "ok")
  const niveau = soucis.some((c) => c.etat === "panne") ? "panne" : soucis.length ? "alerte" : ""
  return html`<a class="pastille-etat ${niveau}" href="#/reglages/etat"><span class="point ${niveau}" aria-hidden="true"></span>${niveau === "panne" ? "Panne" : niveau ? "À surveiller" : "Tout fonctionne"}</a>`
}
function bandeauPanne() {
  const pannes = (etat.sante?.composants ?? []).filter((c) => c.etat === "panne")
  if (!pannes.length || etat.route.section === "etat") return ""
  return html`<div class="message erreur"><span style="flex:1"><strong>${pannes.length === 1 ? "Un service est en panne" : `${pannes.length} services sont en panne`}</strong> : ${pannes.map((c) => nomService(c.nom)).join(", ")}.</span><a class="btn btn-s btn-petit" href="#/reglages/etat">Voir</a></div>`
}

function barreHaut() {
  const u = etat.resume?.usine
  const occupe = u?.taches_en_cours ?? 0
  return html`<div class="barre">
    <button type="button" class="recherche" data-action="palette">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
      <span style="flex:1">Rechercher un projet ou une page…</span><span class="touche mono">Ctrl K</span>
    </button>
    <div class="rangee">${u ? (u.arretee
      ? html`<span class="etat-usine" style="color:var(--signal)"><span class="point alerte"></span>Usine en pause${occupe ? " après ce qu'elle termine" : ""}</span><button type="button" class="btn btn-s btn-petit" data-action="usine" data-quoi="reprendre">Reprendre</button>`
      : html`<span class="etat-usine"><span class="point"></span>${occupe ? "L'usine travaille" : "L'usine est au repos"}</span>`) : ""}${pastilleEtat()}</div>
  </div>${bandeauPanne()}`
}

// Une fenêtre par-dessus la page (création d'un public, invitation, intégration, budget).
// Elle vient de l'état : le rafraîchissement automatique la redessine sans la fermer.
function fenetre(titre, contenu) {
  return html`<div class="voile" data-action="fermer-fenetre"></div>
  <div class="fenetre" role="dialog" aria-modal="true" aria-labelledby="fenetre-titre">
    <div class="barre"><h2 id="fenetre-titre">${titre}</h2><button type="button" class="btn-icone" data-action="fermer-fenetre" aria-label="Fermer">✕</button></div>
    ${contenu}
  </div>`
}

const messageGlobal = () => ""
let dernierMessage = ""
function afficherMessages() {
  const m = etat.message
  const contenu = m ? html`<div class="message ${m.type}" style="margin-bottom:24px"><span style="flex:1">${nettoyer(m.texte)}</span><button type="button" class="btn btn-s btn-petit" data-action="fermer-message">Fermer</button></div>`[BRUT] : ""
  if (contenu === dernierMessage) return
  dernierMessage = contenu
  const zone = $("#messages")
  zone.setAttribute("role", m?.type === "erreur" ? "alert" : "status")
  zone.innerHTML = contenu
}

// --- Premiers pas --------------------------------------------------------------------------
const prochaineEtape = (pp) => pp.etapes.find((e) => e.obligatoire && !e.fait) ?? pp.etapes.find((e) => !e.fait)

// Une petite liste flottante « 2 sur 6 » suit la personne sur toutes les pages (Rox).
function listeFlottante() {
  const pp = etat.premiersPas
  if (!pp || pp.termine || pp.masque || etat.route.vue === "demarrer") return ""
  const e = prochaineEtape(pp)
  return html`<aside class="flottant" aria-label="Premiers pas">
    <div class="barre"><strong>Premiers pas · ${pp.faites} sur ${pp.total} essentiels</strong><button type="button" class="btn-icone" data-action="premiers-pas" data-quoi="masquer" aria-label="Masquer les premiers pas" title="Masquer (ils restent dans les Réglages)">✕</button></div>
    <div class="jauge" role="progressbar" aria-valuemin="0" aria-valuemax="${pp.total}" aria-valuenow="${pp.faites}" aria-label="Avancement des premiers pas"><div style="width:${Math.round((pp.faites / pp.total) * 100)}%"></div></div>
    ${e ? html`<a class="flottant-suite" href="#/demarrer/${e.id}"><span>${e.titre}</span><span aria-hidden="true">→</span></a>` : ""}
  </aside>`
}

// Ce qu'on fait à chaque étape, sur place : l'assistant ne renvoie pas vers une autre page.
function actionEtape(e) {
  if (e.id === "ia") {
    const f = etat.fournisseurs
    if (!f) return html`<div class="chargement">Chargement…</div>`
    return html`<div class="grille">${f.moteurs.map((m) => carteMoteur(f, m))}</div>
      <div class="rangee"><button type="button" class="btn btn-p" data-action="tester-fournisseurs">Tester les connexions</button><span class="aide">${f.tests.le ? `Dernier test : ${dateCourte(f.tests.le)}` : "Une fois branchées, lance le test : l'étape se coche toute seule."}</span></div>`
  }
  if (e.id === "github") return etat.reglages ? html`<div class="carte carte-p">${carteGithub(etat.reglages.forge)}</div>` : html`<div class="chargement">Chargement…</div>`
  if (e.id === "equipe") return etat.acces ? html`<div class="carte carte-p">${formulaireInviter()}</div>` : html`<div class="chargement">Chargement…</div>`
  if (e.id === "persona") return html`<div class="carte carte-p">${formulairePublic()}</div>`
  if (e.id === "projet") return saisieAccueil({ titre: false })
  return ""
}

// L'assistant : un écran par étape, avec « Je le ferai plus tard » partout (Rox, Grain).
function vueDemarrer() {
  const pp = etat.premiersPas
  if (!pp) return html`<div class="chargement">Chargement…</div>`
  const e = pp.etapes.find((x) => x.id === etat.route.etape) ?? prochaineEtape(pp) ?? pp.etapes[0]
  const n = pp.etapes.indexOf(e)
  const avant = pp.etapes[n - 1]
  const apres = pp.etapes[n + 1]
  return html`<div class="assistant">
    <nav class="assistant-etapes" aria-label="Les étapes">
      <a class="retour" href="#/">← Quitter l'assistant</a>
      <div class="pile" style="gap:8px"><strong>Premiers pas</strong><span class="aide">${pp.faites} étape${pp.faites > 1 ? "s" : ""} essentielle${pp.faites > 1 ? "s" : ""} sur ${pp.total} faite${pp.faites > 1 ? "s" : ""}</span>
        <div class="jauge ${pp.termine ? "verte" : ""}"><div style="width:${Math.round((pp.faites / pp.total) * 100)}%"></div></div></div>
      <ol>${pp.etapes.map((x, k) => html`<li><a href="#/demarrer/${x.id}" ${brut(x === e ? 'aria-current="step"' : "")}>
        <span class="puce ${x.fait ? "faite" : ""}" aria-hidden="true">${x.fait ? "✓" : k + 1}</span>
        <span>${x.titre}${x.obligatoire ? "" : html`<small>facultatif</small>`}${x.fait ? html`<span class="cache"> (fait)</span>` : ""}</span></a></li>`)}</ol>
    </nav>
    <section class="assistant-ecran" aria-labelledby="etape-titre">
      <div class="aide">Étape ${n + 1} sur ${pp.etapes.length}${e.obligatoire ? "" : " · facultative"}</div>
      <h1 id="etape-titre">${e.titre}</h1>
      <p class="chapeau">${e.detail}</p>
      ${messageGlobal()}
      ${e.fait ? html`<div class="message ok"><span>C'est fait pour cette étape.</span></div>` : ""}
      ${actionEtape(e)}
      <div class="barre assistant-bas">
        ${avant ? html`<a class="btn btn-s" href="#/demarrer/${avant.id}">← Précédent</a>` : html`<span></span>`}
        ${apres ? html`<a class="btn ${e.fait ? "btn-p" : "btn-s"}" href="#/demarrer/${apres.id}">${e.fait ? "Continuer" : "Je le ferai plus tard"}</a>`
          : html`<a class="btn btn-p" href="#/">${pp.termine ? "Aller à mes projets" : "Terminer pour l'instant"}</a>`}
      </div>
    </section>
  </div>`
}

function vueProjets() {
  const r = etat.resume
  if (!r) return html`<div class="chargement">Chargement…</div>`
  const FILTRES = { actifs: (p) => !["abandonne", "en_production"].includes(p.statut), production: (p) => p.statut === "en_production", archives: (p) => p.statut === "abandonne", tous: () => true }
  const compte = (f) => r.projets.filter(FILTRES[f]).length
  const projets = r.projets.filter(FILTRES[etat.filtre] ?? FILTRES.tous)
  return html`
    ${barreHaut()}
    ${messageGlobal()}
    <div class="entete"><div><h1>Tous les projets</h1><p class="chapeau">Où en est chaque projet, ce qu'il a coûté, ses adresses.</p></div><a class="btn btn-p" href="#/nouveau">+ Nouveau projet</a></div>
    <section class="carte" aria-labelledby="tous">
      <div class="barre" style="padding:14px 16px;border-bottom:1px solid var(--trait)"><h2 id="tous">Projets</h2>
        <div class="rangee" role="group" aria-label="Filtrer les projets">${[["actifs", "Actifs"], ["production", "En production"], ["archives", "Abandonnés"], ["tous", "Tous"]].map(([id, nom]) => html`<button type="button" class="filtre" data-action="filtre" data-id="${id}" aria-pressed="${String(etat.filtre === id)}">${nom} · ${compte(id)}</button>`)}</div></div>
      ${projets.length ? html`<div class="tableau"><table style="min-width:860px">
        <thead><tr><th>Projet</th><th>Où il en est</th><th>Avancement</th><th title="Ce qu'aurait coûté le calcul au tarif des API (les abonnements coûtent moins)">Coût estimé</th><th>Adresses</th></tr></thead>
        <tbody>${projets.map((p) => {
          const a = p.avancement
          const pct = a.total ? Math.round((a.finies / a.total) * 100) : 0
          return html`<tr>
            <td><a class="lien-projet" href="#/projets/${p.id}">${p.nom}</a><div class="sous">${p.resume}</div><div class="sous">${p.repris ? "Application reprise" : BRIQUES[p.brique] ?? ""}</div></td>
            <td><div class="rangee" style="gap:6px"><span class="badge ${p.statut === "en_production" ? "vert" : ["echec"].includes(p.statut) ? "rouge" : "bleu"}">${p.phase?.nom ?? (STATUTS[p.statut] ?? [p.statut])[0]}</span>${pastilleAttente(p)}</div><div class="sous">${p.phase?.etat ?? ""}</div></td>
            <td style="min-width:180px"><div class="rangee" style="flex-wrap:nowrap"><div class="jauge ${p.statut === "en_production" || p.statut === "livre" ? "verte" : ""}" style="flex:1"><div style="width:${pct}%"></div></div><span class="mono aide">${a.finies}/${a.total}</span></div>
              <div class="sous">${a.en_cours ? `En cours : ${a.en_cours.titre}` : p.apercu_vie && p.apercu_vie !== "—" ? `aperçu : ${p.apercu_vie}` : ""}</div></td>
            <td class="mono">${p.cout ?? "—"}</td>
            <td>${p.production ? html`<a href="${p.production}" target="_blank" rel="noopener">production</a>` : ""}${p.production && p.apercu ? " · " : ""}${p.apercu ? html`<a href="${p.apercu}" target="_blank" rel="noopener">aperçu</a>` : ""}${!p.production && !p.apercu ? html`<span class="aide">pas encore</span>` : ""}</td>
          </tr>`
        })}</tbody></table></div>` : html`<div class="vide">${r.projets.length ? "Aucun projet dans ce filtre." : "Aucun projet pour l'instant : décris le premier ci-dessus."}</div>`}
    </section>
`
}

// L'accueil, minimaliste : la question, et une seule ligne quand un projet attend une réponse.
function vueAccueil() {
  const attente = etat.resume?.a_traiter ?? []
  const projets = new Set(attente.map((x) => x.projet)).size
  return html`
    ${barreHaut()}
    ${messageGlobal()}
    <div class="accueil-vide">
      ${saisieAccueil()}
      ${attente.length ? html`<a class="ligne-attente" href="#/projets/${attente[0].projet}"><span class="point-projet pp-attend" aria-hidden="true"></span>
        <span style="flex:1">${projets === 1 ? attente[0].titre : `${projets} projets attendent ta réponse · d'abord ${attente[0].titre}`}</span><span aria-hidden="true">→</span></a>` : ""}
    </div>`
}

// La barre de gauche : les projets comme des conversations, un point de couleur pour leur état.
function listeProjetsCote() {
  const r = etat.resume
  if (!r) return html`<li class="aide" style="padding:6px 12px">Chargement…</li>`
  const actifs = r.projets.filter((p) => p.statut !== "abandonne")
  const archives = r.projets.length - actifs.length
  return html`${actifs.length ? actifs.map((p) => {
    const ton = p.attend?.oui ? "pp-attend" : p.statut === "en_production" ? "pp-en-ligne" : p.statut === "echec" ? "pp-echec" : ""
    const quoi = p.attend?.oui ? ATTENTES[p.attend.quoi] ?? "À traiter" : p.phase?.etat ?? (STATUTS[p.statut] ?? [p.statut])[0]
    return html`<li><a href="#/projets/${p.id}" title="${quoi}" ${brut(etat.route.vue === "projet" && etat.route.id === p.id ? 'aria-current="page"' : "")}>
      <span class="point-projet ${ton}" aria-hidden="true"></span><span class="nom-projet">${p.nom ?? "Nouveau projet"}</span><span class="cache">, ${quoi}</span></a></li>`
  }) : html`<li class="aide" style="padding:6px 12px">Aucun projet pour l'instant.</li>`}
  ${archives ? html`<li><a class="aide" href="#/projets" data-action="voir-archives">Archives · ${archives}</a></li>` : ""}`
}

// Les types de produit, dits simplement (la clé reste celle de la brique).
const TYPES_PRODUIT = [
  ["webapp", "Application web"],
  ["pwa", "Application mobile"],
  ["site", "Site vitrine"],
  ["api", "Connecteur entre logiciels"],
]
const PICTOS_OUTILS = {
  joindre: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m21 11-8.6 8.6a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4L15.6 7"/></svg>`,
  public: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4.5 4.5-6.5 8-6.5s6.5 2 8 6.5"/></svg>`,
  type: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8"/></svg>`,
  depot: html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5"/></svg>`,
}

// Tout commence ici : la demande et ses options tiennent dans la barre du champ (Sana, Emergent).
// « Terminer une application existante » transforme le champ sur place.
function saisieAccueil({ titre = true } = {}) {
  const depot = etat.depart === "depot"
  const liste = personasValides()
  const exemples = [["CRM léger", "Un CRM léger pour une équipe de 5 commerciaux : contacts, opportunités, relances."], ["Site d'architectes", "Le site vitrine d'un cabinet d'architectes, avec réalisations et formulaire de contact."], ["Suivi des congés", "Le suivi des congés de l'équipe : demandes, validation par le manager, calendrier."], ["Interventions", "Une application pour nos techniciens : les interventions du jour, le compte rendu sur place, même sans réseau."]]
  return html`<section class="accueil" aria-labelledby="accueil-titre">
    <form class="pile" data-form="${depot ? "reprendre" : "nouveau"}" style="gap:12px">
      ${titre ? html`<h1 id="accueil-titre">${depot ? "Quelle application faut-il terminer ?" : "Que veux-tu construire ?"}</h1>` : html`<span id="accueil-titre" class="cache">Ta demande</span>`}
      <div class="saisie">
        ${depot ? html`<label class="cache" for="adresse">L'adresse GitHub de l'application</label>
          <input id="adresse" name="adresse" class="saisie-adresse mono" required placeholder="L'adresse GitHub : https://github.com/proprietaire/application" autocomplete="off" spellcheck="false">` : ""}
        <label class="cache" for="demande">${depot ? "Ce que tu veux en faire" : "Ta demande"}</label>
        <textarea id="demande" name="${depot ? "consigne" : "prompt"}" rows="3" ${brut(depot ? "" : 'required minlength="20"')} placeholder="${depot ? "Ce que tu veux en faire, si tu le sais : garder…, ajouter…, pour qui…" : "Décris le besoin comme à un collègue : qui va s'en servir, ce qu'il doit pouvoir faire, ce dont tu n'as pas besoin."}"></textarea>
        ${etat.pieces.length && !depot ? html`<ul class="pieces">${etat.pieces.map((f, i) => html`<li><span>${f.name}</span><span class="aide">${Math.ceil(f.size / 1024)} Ko</span><button type="button" class="btn-icone" data-action="retirer-piece" data-id="${i}" aria-label="Retirer ${f.name}">✕</button></li>`)}</ul>` : ""}
        <div class="saisie-outils">
          ${depot ? "" : html`<label class="outil" title="Maquettes, captures, cahier des charges : 3 fichiers de 2 Mo au plus">${PICTOS_OUTILS.joindre}<span>Joindre</span>
            <input id="pieces" type="file" class="cache" accept="image/png,image/jpeg,image/webp,application/pdf,.md,.markdown,.txt,text/markdown,text/plain" multiple></label>`}
          <label class="outil">${PICTOS_OUTILS.public}<span class="cache">Pour qui ?</span>
            <select name="persona_id" data-choix="persona">
              <option value="">${liste.length ? "Pour qui ?" : "Pour qui ? (aucun public)"}</option>
              ${liste.map((p) => html`<option value="${p.id}" ${String(p.id) === String(etat.personaChoisi ?? "") ? "selected" : ""}>${p.nom}</option>`)}
            </select></label>
          ${depot ? "" : html`<label class="outil">${PICTOS_OUTILS.type}<span class="cache">Quel genre d'outil ?</span>
            <select data-choix="brique">${TYPES_PRODUIT.map(([id, nom]) => html`<option value="${id}" ${id === etat.brique ? "selected" : ""}>${nom}</option>`)}</select></label>`}
          <button type="button" class="outil" data-action="depart" data-id="${depot ? "zero" : "depot"}" aria-pressed="${String(depot)}">${PICTOS_OUTILS.depot}<span>Terminer une application existante</span></button>
          <span style="flex:1"></span>
          <button type="submit" class="btn btn-p btn-petit">${depot ? "Lancer l'examen" : "Lancer"}</button>
        </div>
      </div>
      ${depot ? html`<details class="saisie-plus"><summary class="aide">Où l'usine travaille : automatique (conseillé)</summary>
          <fieldset class="pile" style="margin-top:10px;gap:6px"><legend class="cache">Où l'usine travaille</legend>
          ${[["auto", "Automatique (conseillé)", "L'usine choisit selon les droits qu'on lui a donnés."], ["direct", "Dans l'application d'origine", "Elle propose ses changements au propriétaire, qui les accepte lui-même à la fin."], ["copie", "Dans une copie", "L'original ne bouge pas."]].map(([id, t, x]) => html`<label class="choix"><input type="radio" name="mode" value="${id}" ${id === "auto" ? "checked" : ""}><span><strong>${t}</strong><br><span class="aide">${x}</span></span></label>`)}
          </fieldset><p class="aide">Si l'application est privée, son propriétaire doit d'abord inviter le compte GitHub de l'usine.</p></details>`
      : html`<div class="rangee" style="justify-content:center">${exemples.map(([nom, texte]) => html`<button type="button" class="pastille" data-action="exemple" data-texte="${texte}">${nom}</button>`)}</div>
        ${etat.estimation?.disponible ? html`<p class="aide" style="text-align:center;margin:0">Un projet habituel : environ ${etat.estimation.cout} et ${etat.estimation.duree} de travail de l'usine. Le chiffre exact arrive avec le plan, avant que tu valides.</p>` : ""}`}
    </form>
  </section>`
}

// --- Les publics (personas) ----------------------------------------------------------------
const STATUTS_PERSONA = { recherche: ["Recherche en cours", "bleu"], a_valider: ["À relire", "orange"], valide: ["Prêt", "vert"], echec: ["Recherche échouée", "rouge"] }
const badgePersona = (s) => html`<span class="badge ${(STATUTS_PERSONA[s] ?? ["", ""])[1]}">${(STATUTS_PERSONA[s] ?? [s])[0]}</span>`
const personasValides = () => (etat.personas ?? []).filter((p) => p.statut === "valide")
const initiales = (nom) => String(nom ?? "?").split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((m) => m[0].toUpperCase()).join("") || "?"

// Un public se crée avec un nom et deux phrases (AirOps) : la recherche fait le reste.
const formulairePublic = ({ retour = null } = {}) => html`<form class="pile" data-form="persona-nouveau" style="gap:12px">
  <label class="titre-champ" for="persona-nom">Comment l'appeler ?</label>
  <input id="persona-nom" name="nom" class="champ" required maxlength="80" placeholder="Ex. : Commerçant de quartier">
  <label class="titre-champ" for="persona-brief">Qui est-ce, en deux phrases ?</label>
  <textarea id="persona-brief" name="brief" class="champ" rows="4" required minlength="15" style="resize:vertical;line-height:1.6" placeholder="Ex. : une boulangerie de quartier à Lyon, sans site web, avec des avis Google. Le gérant veut être trouvé par les gens du coin, mais n'a pas le temps de s'en occuper."></textarea>
  <div class="aide">L'usine cherche sur le web (études, forums, avis) et revient avec une fiche et ses sources, en quelques minutes.</div>
  <div class="rangee" style="justify-content:${retour ? "space-between" : "flex-end"}">${retour ?? (etat.fenetre ? html`<button type="button" class="btn btn-s" data-action="fermer-fenetre">Annuler</button>` : "")}<button type="submit" class="btn btn-p">Lancer la recherche</button></div>
</form>`

// Quatre points de départ pour un public : on part de ce qu'on a déjà.
const DEPARTS_PUBLIC = [
  ["decrire", "✎", "Je le décris", "Un nom et deux phrases. L'usine fait la recherche sur le web."],
  ["documents", "▤", "J'ai des documents", "Études, comptes rendus d'entretiens, notes (PDF, CSV, texte). L'usine les lit d'abord."],
  ["drive", "▲", "Depuis Google Drive", "Le lien d'un dossier ou d'un document partagé avec l'usine : l'usine lit jusqu'à 5 documents."],
  ["github", "⌥", "Depuis un dépôt GitHub", "Le README et la documentation d'un projet existant, lus avec le compte GitHub de l'usine."],
  ["fiche", "⇪", "J'ai déjà une fiche", "Un fichier préparé sur ta machine, par exemple avec ton assistant. Aucune recherche, rien n'est consommé."],
]
const MODELE_PERSONA = {
  nom: "Commerçant de quartier",
  brief: "Une boulangerie de quartier sans site web, avec des avis Google.",
  fiche: {
    resume: "Gérant d'un commerce de proximité, peu de temps, veut être trouvé par les gens du coin.",
    demographie: ["45-60 ans", "1 à 5 salariés"], psychographie: ["Pragmatique", "Méfiant envers les agences"],
    problemes: [{ probleme: "Invisible sur Google Maps", preuve: "62 % des recherches locales finissent par une visite", source: "https://exemple.fr/etude" }, { probleme: "…", preuve: "…", document: "entretiens-clients.pdf" }],
    besoins: ["Être trouvé", "Répondre aux avis"], outils_actuels: ["Facebook", "Fiche Google"], prix_acceptable: "20 € par mois",
    objections: ["Trop compliqué"], canaux: ["Chambre de commerce"],
    sources: [{ titre: "Étude sur la recherche locale", url: "https://exemple.fr/etude" }, { titre: "Entretiens clients", document: "entretiens-clients.pdf" }],
  },
  hors_perimetre: ["Boutique en ligne"],
  scenarios: [{ titre: "Répondre à un avis négatif depuis son téléphone", situation: "Un client mécontent a laissé une étoile.", etapes: ["Ouvre l'application", "Trouve l'avis", "Répond"], attendu: "La réponse est publiée en moins de 2 minutes." }],
}
const CONSIGNE_ASSISTANT = (adresse, jeton) => `Prépare la fiche d'un persona pour mon usine logicielle, à partir de mes documents et de ce que tu sais de mon activité.
Écris un fichier persona.json au format ci-dessous (en français, sans rien inventer : chaque problème cite sa source, une page web dans "source" ou un de mes documents dans "document").
Règles pour qu'il soit validable : au moins 3 problèmes, 2 besoins, 2 sources, 1 élément hors périmètre, et 3 à 5 scénarios qui disent chacun la situation et le résultat attendu.
${jeton ? `Puis envoie-le à l'usine :
curl -X POST ${adresse}/api/import/personas -H "Authorization: Bearer ${jeton}" -H "Content-Type: application/json" --data @persona.json
` : ""}
Format :
${JSON.stringify(MODELE_PERSONA, null, 2)}`

function creationPublic() {
  const d = etat.departPublic
  if (!d) return html`<div class="pile" style="gap:14px">
    <p class="aide" style="margin:0">Pars de ce que tu as déjà. Tu pourras tout relire et corriger avant de l'utiliser.</p>
    <div class="departs">${DEPARTS_PUBLIC.map(([id, picto, titre, texte]) => html`<button type="button" class="depart" data-action="depart-public" data-id="${id}">
      <span class="depart-picto" aria-hidden="true">${picto}</span><strong>${titre}</strong><span class="aide">${texte}</span></button>`)}</div>
    <div class="separe aide">Tu prépares tes publics sur ton ordinateur, avec un script ou ton assistant ? <button type="button" class="lien-bouton" data-action="fenetre" data-quoi="machine">Envoie-les depuis ta machine</button>.</div>
  </div>`
  const retour = html`<button type="button" class="lien-bouton" data-action="depart-public" data-id="">← Autres façons</button>`
  const nom = html`<label class="titre-champ" for="persona-nom">Comment l'appeler ?</label>
    <input id="persona-nom" name="nom" class="champ" required maxlength="80" placeholder="Ex. : Commerçant de quartier">`
  const boutons = (texte) => html`<div class="rangee" style="justify-content:space-between">${retour}<button type="submit" class="btn btn-p">${texte}</button></div>`
  if (d === "decrire") return html`<div class="pile" style="gap:10px">${formulairePublic({ retour })}</div>`
  if (d === "documents") return html`<form class="pile" data-form="persona-nouveau" style="gap:12px">${nom}
    <label class="titre-champ" for="persona-docs">Tes documents <span class="aide" style="font-weight:400">· 5 au plus, 2 Mo chacun</span></label>
    <label class="depot-fichiers" for="persona-docs"><span aria-hidden="true">▤</span><span><strong>Choisir des fichiers</strong><br><span class="aide">PDF, Markdown, texte, CSV ou images. Depuis Google Drive : Fichier, Télécharger, en PDF ou en CSV.</span></span></label>
    <input id="persona-docs" name="documents" type="file" multiple accept=".pdf,.md,.markdown,.txt,.csv,.png,.jpg,.jpeg,.webp" class="cache-visuel" data-fichiers="persona-docs-liste">
    <ul class="liste-fichiers" id="persona-docs-liste"></ul>
    <label class="titre-champ" for="persona-brief">Ce que l'usine doit savoir en plus <span class="aide" style="font-weight:400">· facultatif</span></label>
    <textarea id="persona-brief" name="brief" class="champ" rows="2" placeholder="Ex. : on vise surtout les gérants qui n'ont pas encore de site."></textarea>
    ${boutons("Lancer la recherche")}</form>`
  if (d === "drive") return etat.drive?.configure ? html`<form class="pile" data-form="persona-nouveau" style="gap:12px">${nom}
    <label class="titre-champ" for="persona-drive">Le lien du dossier ou du document</label>
    <input id="persona-drive" name="drive" class="champ mono" required placeholder="https://drive.google.com/drive/folders/…" spellcheck="false" autocomplete="off">
    <div class="aide">Partage-le d'abord avec <span class="mono">${etat.drive.email}</span> (lecteur suffit). Dans un dossier, l'usine lit les 5 documents les plus récents : Docs, Sheets, Slides, PDF, texte, CSV, images.</div>
    <label class="titre-champ" for="persona-brief">Ce que l'usine doit savoir en plus <span class="aide" style="font-weight:400">· facultatif</span></label>
    <textarea id="persona-brief" name="brief" class="champ" rows="2" placeholder="Ex. : ce dossier contient les entretiens avec nos clients restaurateurs."></textarea>
    ${boutons("Lancer la recherche")}</form>`
    : html`<div class="pile" style="gap:12px">
      <div class="message info"><span>Google Drive n'est pas encore branché. Il faut une fois une adresse réservée à l'usine, avec qui tu partages tes dossiers.</span></div>
      <div class="rangee" style="justify-content:space-between">${retour}<button type="button" class="btn btn-p" data-action="fenetre" data-quoi="integration-drive">Brancher Google Drive</button></div></div>`
  if (d === "github") return html`<form class="pile" data-form="persona-nouveau" style="gap:12px">${nom}
    <label class="titre-champ" for="persona-depot">Le dépôt</label>
    <input id="persona-depot" name="depot" class="champ mono" required placeholder="propriétaire/nom, ou https://github.com/propriétaire/nom" spellcheck="false" autocomplete="off">
    <div class="aide">L'usine lit sa description, son README et les fichiers de docs/ avec son propre compte GitHub. Le jeton ne quitte jamais l'usine.</div>
    <label class="titre-champ" for="persona-brief">Ce que l'usine doit savoir en plus <span class="aide" style="font-weight:400">· facultatif</span></label>
    <textarea id="persona-brief" name="brief" class="champ" rows="2" placeholder="Ex. : les utilisateurs de cet outil sont les commerciaux terrain."></textarea>
    ${boutons("Lancer la recherche")}</form>`
  return html`<form class="pile" data-form="persona-importer" style="gap:12px">
    <label class="depot-fichiers" for="persona-fiche"><span aria-hidden="true">⇪</span><span><strong>Choisir la fiche (.json)</strong><br><span class="aide">Ou colle son contenu ci-dessous.</span></span></label>
    <input id="persona-fiche" type="file" accept=".json,application/json" class="cache-visuel" data-fichiers="persona-fiche-liste">
    <ul class="liste-fichiers" id="persona-fiche-liste"></ul>
    <label class="titre-champ" for="persona-json">Contenu de la fiche</label>
    <textarea id="persona-json" name="json" class="champ mono" rows="6" placeholder='{ "nom": "…", "fiche": { "resume": "…" }, … }' spellcheck="false"></textarea>
    <div class="rangee" style="gap:8px"><button type="button" class="btn btn-s btn-petit" data-action="modele-persona">Télécharger le modèle</button><button type="button" class="btn btn-s btn-petit" data-action="copier" data-quoi="consigne">Copier la consigne pour ton assistant</button></div>
    ${boutons("Importer la fiche")}</form>`
}

// Depuis sa machine : un jeton qui ne sert qu'à envoyer des fiches.
function fenetreMachine() {
  const j = etat.jetons
  const adresse = location.origin
  const c = etat.jetonCree
  return fenetre("Envoyer des publics depuis ta machine", html`<div class="pile" style="gap:16px">
    <p style="margin:0">Prépare la fiche sur ton ordinateur (avec ton assistant, un script ou à la main), puis envoie-la à l'usine. Elle arrive ici, prête à relire.</p>
    ${c ? html`<div class="message ok pile" style="gap:8px;align-items:stretch"><strong>Ton jeton « ${c.nom} » : copie-le maintenant, il ne sera plus affiché.</strong>
      <code class="mono jeton">${c.jeton}</code>
      <div class="rangee" style="gap:8px"><button type="button" class="btn btn-s btn-petit" data-action="copier" data-quoi="jeton">Copier le jeton</button><button type="button" class="btn btn-s btn-petit" data-action="copier" data-quoi="commande">Copier la commande</button><button type="button" class="btn btn-s btn-petit" data-action="copier" data-quoi="consigne-jeton">Copier la consigne pour ton assistant</button></div></div>` : ""}
    <ol class="etapes-machine">
      <li><strong>Crée un jeton</strong> pour ton ordinateur. Il ne sert qu'à envoyer des fiches : il n'ouvre ni la console, ni les applications.
        <form class="rangee" data-form="jeton-persona" style="flex-wrap:nowrap;margin-top:8px"><label class="cache" for="jeton-nom">Nom du jeton</label><input id="jeton-nom" name="nom" class="champ" required maxlength="60" placeholder="Ex. : Ordinateur de Marie"><button type="submit" class="btn btn-p">Créer</button></form></li>
      <li><strong>Prépare la fiche</strong> au format du modèle. <button type="button" class="lien-bouton" data-action="modele-persona">Télécharger le modèle</button>, ou donne la consigne à ton assistant (Claude Code, par exemple) : il lit tes documents et écrit la fiche.</li>
      <li><strong>Envoie-la</strong> :
        <pre class="commande mono">curl -X POST ${adresse}/api/import/personas \\
  -H "Authorization: Bearer usp_…" \\
  -H "Content-Type: application/json" \\
  --data @persona.json</pre>
        <span class="aide">Sous Windows (PowerShell), écris curl.exe. La réponse donne l'adresse de la fiche.</span></li>
    </ol>
    <div class="pile" style="gap:6px"><strong>Tes jetons</strong>
      ${!j ? html`<div class="chargement">Chargement…</div>` : j.length ? html`<ul class="membres carte">${j.map((x) => html`<li><span class="mono">${x.debut}…</span><strong style="flex:1">${x.nom}</strong>
        <span class="aide">${x.utilise_le ? `utilisé le ${dateCourte(x.utilise_le)}` : "jamais utilisé"}</span>
        <button type="button" class="btn btn-s btn-petit" data-action="retirer-jeton" data-id="${x.id}" aria-label="Retirer le jeton ${x.nom}">Retirer</button></li>`)}</ul>` : html`<div class="aide">Aucun jeton pour l'instant.</div>`}</div>
  </div>`)
}

// Ce qu'il manque pour valider : les mêmes règles que l'usine, en liste à cocher.
function pretAValider(p) {
  const f = p.fiche ?? {}
  const n = (p.scenarios ?? []).length
  const points = [
    [Boolean(f.resume), "Un résumé"],
    [(f.problemes ?? []).length >= 3, `3 problèmes réels (${(f.problemes ?? []).length})`],
    [(f.besoins ?? []).length >= 2, `2 besoins (${(f.besoins ?? []).length})`],
    [(f.sources ?? []).length >= 2, `2 sources (${(f.sources ?? []).length})`],
    [(p.hors_perimetre ?? []).length >= 1, "1 chose hors périmètre"],
    [n >= 3 && n <= 5 && (p.scenarios ?? []).every((x) => x.situation && x.attendu), `3 à 5 situations de test (${n})`],
  ]
  const faits = points.filter(([ok]) => ok).length
  return html`<div class="carte carte-p pile" style="gap:10px"><div class="barre"><strong>${faits === points.length ? "Prêt à valider" : "Pour pouvoir valider"}</strong><span class="aide">${faits} sur ${points.length}</span></div>
    <div class="jauge" role="progressbar" aria-valuemin="0" aria-valuemax="${points.length}" aria-valuenow="${faits}" aria-label="Fiche complète"><span style="width:${Math.round((faits / points.length) * 100)}%"></span></div>
    <ul class="coches">${points.map(([ok, texte]) => html`<li class="${ok ? "fait" : ""}"><span class="puce ${ok ? "faite" : ""}" aria-hidden="true">${ok ? "✓" : ""}</span>${texte}<span class="cache">${ok ? " : fait" : " : à compléter"}</span></li>`)}</ul></div>`
}

// La recherche en cours : les étapes s'allument tour à tour, pour voir que l'usine travaille.
function rechercheEnCours(p) {
  const etapes = [...(p.documents?.length ? [`Lecture de tes ${p.documents.length} document(s)`] : []), "Recherche sur le web", "Les problèmes et leurs preuves", "Les situations de test"]
  return html`<section class="carte carte-p pile recherche-en-cours" aria-live="polite"><strong>L'usine étudie « ${p.nom} »</strong>
    <ol class="etapes-recherche">${etapes.map((e, i) => html`<li style="animation-delay:${i * 2.5}s">${e}</li>`)}</ol>
    <span class="aide">Quelques minutes. Cette page se met à jour toute seule.</span></section>`
}

function vuePersonas() {
  const liste = etat.personas
  return html`
    ${barreHaut()}
    <div class="entete">
      <div><h1>Publics</h1><p class="chapeau">Les personnes pour qui tu construis. L'usine les étudie sur le web, construit pour elles, puis essaie chaque application à leur place avant de te la livrer.</p></div>
      <div class="rangee" style="gap:8px"><button type="button" class="btn btn-s" data-action="fenetre" data-quoi="machine">Depuis ma machine</button>${liste?.length ? html`<button type="button" class="btn btn-p" data-action="fenetre" data-quoi="public">+ Nouveau public</button>` : ""}</div>
    </div>
    ${messageGlobal()}
    ${!liste ? html`<div class="chargement">Chargement…</div>` : liste.length ? html`<div class="cartes-publics">${liste.map((p) => html`<a class="carte carte-public" href="#/personas/${p.id}">
        <span class="avatar" aria-hidden="true">${initiales(p.nom)}</span>
        <span class="pile" style="gap:4px;min-width:0"><span class="rangee" style="gap:8px"><strong>${p.nom}</strong>${badgePersona(p.statut)}</span>
          <span class="aide">${p.fiche?.resume ?? p.brief}</span>
          ${p.fiche ? html`<span class="aide">${p.scenarios?.length ?? 0} situations de test · ${p.fiche.sources?.length ?? 0} sources</span>` : ""}</span>
      </a>`)}</div>`
    : html`<section class="carte vide-grand">
        <span class="avatar grand" aria-hidden="true">?</span>
        <h2>Aucun public pour l'instant</h2>
        <p class="aide">Pars de deux phrases, de tes documents, d'un dépôt GitHub ou d'une fiche déjà prête. L'usine construit pour ce public, puis essaie l'application à sa place.</p>
        <button type="button" class="btn btn-p" data-action="fenetre" data-quoi="public">Décrire un premier public</button>
      </section>`}`
}

const lignes = (l) => (l ?? []).join("\n")
const lienSur = (url, texte) => (/^https?:\/\//.test(String(url ?? "")) ? html`<a href="${url}" target="_blank" rel="noopener noreferrer">${texte || url}</a>` : html`<span>${texte || url}</span>`)

// La fiche se lit comme un profil ; chaque section se modifie d'un clic, sans un mur de champs.
function vuePersona() {
  const p = etat.persona
  if (!p || p.id !== etat.route.id) return html`${barreHaut()}<div class="chargement">Chargement…</div>`
  const f = p.fiche ?? {}
  const scenarios = etat.personaScenarios ?? p.scenarios ?? []
  const ed = etat.personaSection
  const zone = (nom, titre, valeur, aide, rangs = 3) => html`<div class="pile"><label class="titre-champ" for="pf-${nom}">${titre}</label><textarea id="pf-${nom}" name="${nom}" class="champ" rows="${rangs}" style="resize:vertical;line-height:1.5">${valeur}</textarea>${aide ? html`<div class="aide">${aide}</div>` : ""}</div>`
  const puces = (l) => (l?.length ? html`<ul class="puces">${l.map((x) => html`<li>${x}</li>`)}</ul>` : html`<div class="aide">Rien pour l'instant.</div>`)
  const etiquettes = (l) => (l?.length ? html`<div class="rangee" style="gap:6px">${l.map((x) => html`<span class="etiquette">${x}</span>`)}</div>` : html`<div class="aide">Rien pour l'instant.</div>`)
  const section = (id, titre, lecture, edition) => html`<section class="carte carte-p pile" aria-labelledby="sec-${id}">
    <div class="barre"><h2 id="sec-${id}">${titre}</h2>${ed === id ? "" : html`<button type="button" class="btn btn-s btn-petit" data-action="persona-section" data-id="${id}" ${ed ? "disabled" : ""}>Modifier</button>`}</div>
    ${ed === id ? html`<form class="pile" data-form="persona" style="gap:12px">${edition}
      <div class="rangee"><button type="submit" class="btn btn-p btn-petit">Enregistrer</button><button type="button" class="btn btn-s btn-petit" data-action="persona-section" data-id="">Annuler</button></div></form>` : lecture}
  </section>`
  return html`
    ${barreHaut()}
    <a class="retour" href="#/personas">← Publics</a>
    ${messageGlobal()}
    <section class="carte profil">
      <span class="avatar grand" aria-hidden="true">${initiales(p.nom)}</span>
      <div class="pile" style="gap:6px;flex:1;min-width:220px">
        <div class="rangee" style="gap:10px"><h1>${p.nom}</h1>${badgePersona(p.statut)}</div>
        <p class="chapeau" style="margin:0">${f.resume || p.brief}</p>
        ${p.fiche ? html`<div class="rangee aide" style="gap:16px">${f.prix_acceptable ? html`<span>Prêt à payer : <strong>${f.prix_acceptable}</strong></span>` : ""}<span>${scenarios.length} situations de test</span><span>${(f.sources ?? []).length} sources</span></div>` : ""}
      </div>
      <div class="pile" style="gap:8px">
        ${p.statut === "a_valider" ? html`<button type="button" class="btn btn-p" data-action="persona-valider">C'est bon, utiliser ce public</button>` : ""}
        ${p.statut === "valide" ? html`<button type="button" class="btn btn-p" data-action="construire-pour" data-id="${p.id}">Construire pour ce public</button>` : ""}
      </div>
    </section>
    ${p.statut === "recherche" ? rechercheEnCours(p) : ""}
    ${!p.fiche && p.documents?.length ? html`<div class="carte carte-p pile" style="gap:6px"><strong>Documents fournis</strong><ul class="puces">${p.documents.map((x) => html`<li class="mono" style="font-size:13px">${x.nom.replace(/^\d-/, "")}</li>`)}</ul></div>` : ""}
    ${p.statut === "echec" ? html`<div class="message erreur"><span style="flex:1">La recherche n'a pas abouti : ${p.erreur ?? "raison inconnue"}</span><button type="button" class="btn btn-s btn-petit" data-action="persona-approfondir">Relancer la recherche</button></div>` : ""}
    ${p.statut === "a_valider" ? html`<div class="message info"><span>La fiche est prête : lis-la, corrige une section si besoin avec « Modifier », puis valide-la en haut.</span></div>` : ""}
    ${p.fiche ? html`<div class="colonnes">
      <div class="colonne-large pile" style="gap:16px">
        ${section("qui", "Qui il est",
          html`<div class="grille"><div class="pile" style="gap:6px"><div class="aide">Son profil</div>${etiquettes(f.demographie)}</div><div class="pile" style="gap:6px"><div class="aide">Ce qui le motive, ce qui l'inquiète</div>${puces(f.psychographie)}</div></div>`,
          html`<div class="pile"><label class="titre-champ" for="pf-nom">Nom</label><input id="pf-nom" name="nom" class="champ" value="${p.nom}" maxlength="80"></div>
            ${zone("resume", "En deux phrases", f.resume, "Qui il est, ce qu'il cherche à obtenir.")}
            ${zone("demographie", "Son profil", lignes(f.demographie), "Une information par ligne (âge, métier, taille de l'entreprise…).")}
            ${zone("psychographie", "Ce qui le motive, ce qui l'inquiète", lignes(f.psychographie), "Une idée par ligne.")}`)}
        ${section("problemes", "Ses problèmes",
          (f.problemes ?? []).length ? html`<ol class="problemes">${f.problemes.map((x) => html`<li><strong>${x.probleme}</strong>${x.preuve ? html`<div class="aide">${x.preuve}${x.source ? html` · ${lienSur(x.source, "source")}` : x.document ? html` · ▤ ${x.document}` : ""}</div>` : ""}</li>`)}</ol>` : html`<div class="aide">Rien pour l'instant.</div>`,
          zone("problemes", "Ses problèmes", lignes((f.problemes ?? []).map((x) => [x.probleme, x.preuve, x.source || (x.document ? `document : ${x.document}` : "")].filter(Boolean).join(" | "))), "Un problème par ligne. La preuve et la source suivent, séparées par « | » (une adresse web, ou « document : nom du fichier »).", 6))}
        ${section("attentes", "Ce qu'il attend",
          html`<div class="grille">
            <div class="pile" style="gap:6px"><div class="aide">Ses besoins</div>${puces(f.besoins)}</div>
            <div class="pile" style="gap:6px"><div class="aide">Ce qui le ferait renoncer</div>${puces(f.objections)}</div>
            <div class="pile" style="gap:6px"><div class="aide">Ce qu'il utilise aujourd'hui</div>${etiquettes(f.outils_actuels)}</div>
            <div class="pile" style="gap:6px"><div class="aide">Où le trouver</div>${etiquettes(f.canaux)}</div></div>`,
          html`${zone("besoins", "Ses besoins", lignes(f.besoins), "Un par ligne.", 4)}
            ${zone("objections", "Ce qui le ferait renoncer", lignes(f.objections), "Une raison par ligne.")}
            ${zone("outils_actuels", "Ce qu'il utilise aujourd'hui", lignes(f.outils_actuels), "Un outil par ligne.")}
            ${zone("canaux", "Où le trouver", lignes(f.canaux), "Un endroit par ligne.")}
            <div class="pile"><label class="titre-champ" for="pf-prix">Ce qu'il est prêt à payer</label><input id="pf-prix" name="prix_acceptable" class="champ" value="${f.prix_acceptable ?? ""}"></div>`)}
        ${section("situations", `Les situations de test · ${scenarios.length}`,
          html`<div class="aide">L'usine les joue à la fin de chaque projet, à la place de ce public. Celui qui construit ne les voit jamais.</div>
            <ol class="situations">${scenarios.map((s) => html`<li class="carte carte-p pile" style="gap:4px;background:var(--fond)"><strong>${s.titre}</strong><span class="aide">${s.situation}</span><span>Il doit obtenir : ${s.attendu}</span></li>`)}</ol>`,
          html`${scenarios.map((s, i) => html`<fieldset class="carte carte-p pile" data-scenario="${i}" style="background:var(--fond)">
            <div class="rangee" style="justify-content:space-between"><strong>Situation ${i + 1}</strong><button type="button" class="btn btn-s btn-petit" data-action="persona-retirer-scenario" data-id="${i}">Retirer</button></div>
            <label class="titre-champ" for="ps-titre-${i}">En une phrase</label><input id="ps-titre-${i}" class="champ" data-champ="titre" value="${s.titre}">
            <label class="titre-champ" for="ps-situation-${i}">Le contexte</label><textarea id="ps-situation-${i}" class="champ" data-champ="situation" rows="2">${s.situation}</textarea>
            <label class="titre-champ" for="ps-etapes-${i}">Ce qu'il fait <span class="aide" style="font-weight:400">· une action par ligne</span></label><textarea id="ps-etapes-${i}" class="champ" data-champ="etapes" rows="3">${lignes(s.etapes)}</textarea>
            <label class="titre-champ" for="ps-attendu-${i}">Ce qu'il doit obtenir</label><textarea id="ps-attendu-${i}" class="champ" data-champ="attendu" rows="2">${s.attendu}</textarea>
          </fieldset>`)}
          ${scenarios.length < 5 ? html`<div><button type="button" class="btn btn-s btn-petit" data-action="persona-ajouter-scenario">+ Ajouter une situation</button></div>` : ""}`)}
        ${section("hors", "Ce qu'on ne construit pas pour lui", etiquettes(p.hors_perimetre),
          zone("hors_perimetre", "Hors sujet", lignes(p.hors_perimetre), "Une chose par ligne. L'usine s'en tiendra à l'écart dans chaque projet pour ce public.", 4))}
        ${section("sources", "Les sources consultées",
          (f.sources ?? []).length ? html`<ul class="puces">${f.sources.map((s) => html`<li>${s.url ? lienSur(s.url, s.titre) : html`▤ ${s.titre || s.document} <span class="aide">· document ${s.document}</span>`}</li>`)}</ul>` : html`<div class="aide">Aucune source.</div>`,
          zone("sources", "Sources", lignes((f.sources ?? []).map((s) => { const ou = s.url || `document : ${s.document}`; return s.titre ? `${s.titre} | ${ou}` : ou })), "Une par ligne : titre | adresse web, ou titre | document : nom du fichier.", 4))}
      </div>
      <aside class="colonne-etroite pile">
        ${p.statut === "valide" ? html`<div class="message ok"><span>Prêt${p.valide_par ? `, relu par ${p.valide_par}` : ""}. Si tu modifies la fiche, il faudra la relire.</span></div>` : pretAValider(p)}
        ${p.documents?.length ? html`<div class="carte carte-p pile" style="gap:6px"><strong>Documents lus</strong><ul class="puces">${p.documents.map((x) => html`<li class="mono" style="font-size:13px">${x.nom.replace(/^\d-/, "")}</li>`)}</ul></div>` : ""}
        <div class="carte carte-p pile"><strong>Creuser davantage</strong>
          <label class="cache" for="consignes-persona">Ce que la recherche doit creuser</label>
          <textarea id="consignes-persona" class="champ" rows="4" placeholder="Ex. : regarde surtout les commerces alimentaires, et ce qu'ils paient déjà pour se faire connaître."></textarea>
          <div><button type="button" class="btn btn-s" data-action="persona-approfondir" ${p.statut === "recherche" ? "disabled" : ""}>Relancer la recherche</button></div>
          <div class="aide">L'usine repart de la fiche actuelle et la complète.</div></div>
        <div class="carte carte-p pile"><strong>Projets pour ce public</strong>
          ${p.projets?.length ? html`<ul style="margin:0;padding-left:18px">${p.projets.map((x) => html`<li><a href="#/projets/${x.id}">${x.nom ?? `Projet ${x.id}`}</a></li>`)}</ul>` : html`<div class="aide">Aucun projet pour l'instant.</div>`}
          ${p.projets?.length ? "" : html`<div><button type="button" class="btn btn-d btn-petit" data-action="persona-supprimer">Supprimer ce public</button></div>`}</div>
      </aside>
    </div>` : ""}`
}

// Une application reprise, dans la page d'un projet : d'où elle vient et ce que l'usine a trouvé.
// Le détail technique (langage, commandes) reste replié.
function blocReprise(p) {
  const o = p.origine
  if (!o) return ""
  const inv = p.inventaire
  const ETAT = { marche: ["marche", "vert"], partiel: ["à moitié", "orange"], casse: ["cassé", "rouge"] }
  return html`<section class="carte carte-p pile" aria-labelledby="reprise"><h2 id="reprise">Application reprise</h2>
    <div class="aide">Elle vient de <a href="${o.url}" target="_blank" rel="noopener">${o.depot}</a>. ${o.mode === "direct" ? "L'usine travaille à côté de l'original : à la fin, elle propose ses changements, que le propriétaire accepte lui-même." : "L'usine travaille sur une copie : l'original ne bouge pas."}</div>
    ${p.pr_livraison ? html`<div class="message ok"><span style="flex:1">Les changements sont prêts à être acceptés dans l'application d'origine.</span><a class="btn btn-s btn-petit" href="${p.pr_livraison}" target="_blank" rel="noopener">Les voir sur GitHub</a></div>` : ""}
    ${inv ? html`<details ${p.statut === "plan_a_valider" ? "open" : ""}><summary style="cursor:pointer;font-weight:600">Ce que l'usine a trouvé · ${inv.fonctionnalites.filter((f) => f.etat === "marche").length} fonction(s) sur ${inv.fonctionnalites.length} qui marchent</summary>
      <div class="pile" style="margin-top:10px">
        <p style="margin:0">${inv.resume}</p>
        ${inv.fonctionnalites.length ? html`<ul style="margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:6px">${inv.fonctionnalites.map((f) => html`<li class="rangee" style="flex-wrap:nowrap;align-items:flex-start"><span class="badge ${(ETAT[f.etat] ?? ["", ""])[1]}">${(ETAT[f.etat] ?? [f.etat])[0]}</span><span><strong>${f.nom}</strong>${f.detail ? html`<span class="aide"> · ${f.detail}</span>` : ""}</span></li>`)}</ul>` : ""}
        ${inv.manques.length ? html`<div><strong>Ce qui manque</strong><ul style="margin:4px 0 0;padding-left:18px">${inv.manques.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}
        <details><summary class="aide" style="cursor:pointer">Pour les techniciens</summary>
          <div class="pile" style="margin-top:8px">
            <div class="aide">Branche ${o.branche_source}${o.mode === "direct" ? `, intégration sur ${p.branche}` : ""}${p.profil ? ` · ${p.profil.pile}` : ""} · ${inv.tests} test(s)</div>
            ${inv.changements.length ? html`<div><strong>Mise au contrat d'hébergement</strong><ul style="margin:4px 0 0;padding-left:18px">${inv.changements.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}
            ${p.profil ? html`<div class="aide mono">installer : ${p.profil.installer} · construire : ${p.profil.construire} · tester : ${p.profil.tester} · démarrer : ${p.profil.demarrer}</div>` : ""}
          </div></details>
      </div></details>` : p.statut === "analyse" ? html`<div class="aide">L'usine examine l'application…</div>` : ""}
  </section>`
}

// La pyramide de l'expérience : chaque étage noté sur le produit fini, du sommet à la base,
// le gouffre entre « Utilisable » et « Pratique ».
function blocPyramide(r) {
  if (!r.pyramide) return ""
  const etages = r.pyramide.map((n, i) => ({ ...n, i })).reverse()
  return html`<div class="pile" style="gap:6px">
    <div><strong>Pyramide de l'expérience</strong><span class="aide" style="display:block">${r.verdict_pyramide}</span></div>
    <ol style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;align-items:center;gap:4px">${etages.map((n) => html`
      ${n.i === r.gouffre - 1 ? html`<li aria-hidden="true" class="aide" style="width:100%;text-align:center;border-top:1px dashed currentColor;padding-top:2px">au-dessus : ce qui fait aimer un produit</li>` : ""}
      <li title="${n.observe}" style="width:${46 + n.i * 9}%;min-width:190px;border-radius:8px;padding:6px 10px;display:flex;justify-content:space-between;gap:8px;background:${(n.note ?? 0) >= r.seuil ? (n.i <= r.etage ? "var(--ok-fond)" : "var(--signal-fond)") : "var(--danger-fond)"};color:var(--encre)">
        <span>${n.i === r.etage ? html`<strong>${n.nom}</strong>` : n.nom}</span><span class="mono">${n.note ?? "?"}/10</span>
      </li>`)}</ol>
    ${(() => {
      const suivant = r.pyramide[r.etage + 1]
      return suivant?.pour_monter ? html`<div class="aide"><strong>Pour monter à « ${suivant.nom} » :</strong> ${suivant.pour_monter}</div>` : ""
    })()}
  </div>`
}

// La recette : les scénarios cachés du persona (s'il y en a) et la pyramide, joués sur le produit fini.
function blocRecette(p) {
  const r = p.recette
  if (!r) return ""
  const points = r.points ?? (r.scenarios ?? []).filter((s) => !s.tenu).length
  return html`<section class="carte carte-p pile" aria-labelledby="recette"><div class="rangee" style="justify-content:space-between"><h2 id="recette">Recette${r.persona ? ` du persona « ${r.persona} »` : ""}</h2>
    ${r.erreur ? html`<span class="badge rouge">impossible</span>` : r.total ? html`<span class="badge ${r.tenus === r.total ? "vert" : "orange"}">${r.tenus}/${r.total} scénario(s) tenu(s)</span>` : ""}</div>
    ${r.erreur ? html`<div class="aide">La recette n'a pas pu être jouée : ${r.erreur}</div>` : html`
      ${r.resume ? html`<p style="margin:0">${r.resume}</p>` : ""}
      ${blocPyramide(r)}
      ${r.total ? html`<ul style="margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:8px">${r.scenarios.map((s) => html`<li class="rangee" style="flex-wrap:nowrap;align-items:flex-start"><span class="badge ${s.tenu ? "vert" : "rouge"}">${s.tenu ? "tenu" : "écart"}</span><span><strong>${s.titre}</strong><span class="aide" style="display:block">${s.tenu ? s.observe : s.ecart || s.observe}</span></span></li>`)}</ul>` : ""}
      ${points && r.propositions?.length && ["livre", "en_production"].includes(p.statut) ? html`<div class="pile suite" style="gap:8px">
        <strong>La suite proposée</strong><span class="aide">Coche ce que l'usine doit corriger : l'analyste en fait un lot de corrections.</span>
        ${r.propositions.map((x, i) => html`<label class="coche"><input type="checkbox" name="garder" value="${i}" checked><span>${x}</span></label>`)}
        <label class="cache" for="recette-ajout">Ajouter une demande</label><input id="recette-ajout" class="champ" placeholder="Ajouter une demande…">
        <div><button type="button" class="btn btn-p" data-action="corriger-recette">Lancer ces corrections</button></div>
      </div>` : ""}`}
    <div class="aide">Essayée sur la dernière version${r.persona ? `, à la place de « ${r.persona} ». Celui qui construit n'a jamais vu ces situations.` : ", comme le ferait un nouvel utilisateur."}</div>
  </section>`
}

// Les étapes d'une fonction, nommées pour l'utilisateur (la liste et l'étape viennent du serveur).
function etapesTache(t, noms) {
  const fait = t.etape ?? 0
  return html`<ol class="etapes" aria-label="Étapes de la fonction">${noms.map((n, i) => html`<li class="${i < fait ? "fait" : i === fait ? "encours" : ""}">${n}</li>`)}</ol>`
}

// Une décision attendue : en tête de page, ce qui bloque en une phrase, ce que le contrôle a vu,
// la recommandation de l'usine, et chaque choix avec sa conséquence.
function blocDecision(p, e) {
  const d = e.presentation
  const avecConsigne = d.options.some((o) => o.cle === "A")
  return html`<section class="carte carte-p pile decision" aria-labelledby="decision-${e.id}">
    <div class="surtitre" style="color:var(--signal)">Ta décision</div>
    <h2 id="decision-${e.id}">${d.titre}</h2>
    <p style="margin:0;color:var(--texte)">L'usine s'est arrêtée parce que ${d.raison}.</p>
    ${d.vu.length ? html`<div><strong style="font-size:14px">Ce que le contrôle a vu</strong><ul class="vu">${d.vu.map((x) => html`<li>${nettoyer(x)}</li>`)}</ul></div>` : ""}
    ${d.pourquoi ? html`<div class="message info"><span><strong>L'usine recommande : ${d.options.find((o) => o.recommande)?.libelle ?? ""}.</strong> ${d.pourquoi}</span></div>` : ""}
    ${avecConsigne ? html`<label class="titre-champ" for="consigne-${e.id}">Ta consigne pour l'agent <span class="aide" style="font-weight:400">· facultative, utilisée si l'usine reprend</span></label>
      <textarea id="consigne-${e.id}" class="champ" rows="2" placeholder="Ex. : filtre sur la date du dernier email envoyé, pas sur la date de création du contact."></textarea>` : ""}
    <div class="options-decision">${d.options.map((o) => html`<button type="button" class="choix-decision${o.recommande ? " recommande" : ""}" data-action="decider" data-id="${e.id}" data-choix="${o.cle}">
      <strong>${o.libelle}${o.recommande ? html` <span class="badge bleu">recommandé</span>` : ""}</strong><span>${o.consequence || o.detail}</span></button>`)}</div>
    ${["fabrication", "bloque"].includes(p.statut) ? html`<button type="button" class="lien-btn" style="align-self:flex-start;padding-left:0" data-action="ouvrir-reorienter">Ou changer de direction pour tout le projet</button>` : ""}
  </section>`
}

// Les questions de l'analyste, une à la fois : les options (la recommandée est cochée d'avance),
// une réponse libre, ou « laisser l'analyste choisir ».
function blocQuestions(p) {
  const qs = p.questions ?? []
  if (!qs.length) return ""
  if (etat.questions?.projet !== p.id) etat.questions = { projet: p.id, i: 0, reponses: qs.map((q) => (q.recommande !== null ? { option: q.recommande } : {})) }
  const s = etat.questions
  const q = qs[s.i]
  const r = s.reponses[s.i] ?? {}
  const derniere = s.i === qs.length - 1
  return html`<section class="carte carte-p pile" style="gap:14px" aria-labelledby="questions-titre">
    <div class="barre"><h2 id="questions-titre">L'analyste a ${qs.length > 1 ? `${qs.length} questions` : "une question"} avant de planifier</h2><span class="aide">Question ${s.i + 1} sur ${qs.length}</span></div>
    <fieldset class="pile" style="gap:8px"><legend style="font-weight:600;font-size:16px;margin-bottom:8px">${q.question}</legend>
      ${q.options.map((o, j) => html`<label class="choix"><input type="radio" name="question" value="${j}" ${r.option === j && !r.libre ? "checked" : ""}><span><strong>${o.libelle}</strong>${j === q.recommande ? html` <span class="badge bleu">recommandé</span>` : ""}${o.detail ? html`<br><span class="aide">${o.detail}</span>` : ""}</span></label>`)}
      <label class="titre-champ" for="question-libre" style="margin-top:4px">${q.options.length ? "Ou ta réponse" : "Ta réponse"}</label>
      <input id="question-libre" class="champ" value="${r.libre ?? ""}" placeholder="${q.options.length ? "Autre chose…" : ""}">
    </fieldset>
    <div class="barre">
      <button type="button" class="lien-btn" style="padding-left:0" data-action="questions-auto">Laisser l'analyste choisir${derniere ? "" : " pour la suite"}</button>
      <div class="rangee">${s.i > 0 ? html`<button type="button" class="btn btn-s" data-action="questions-aller" data-id="${s.i - 1}">Précédente</button>` : ""}${derniere ? html`<button type="button" class="btn btn-p" data-action="questions-envoyer">Envoyer les réponses</button>` : html`<button type="button" class="btn btn-p" data-action="questions-aller" data-id="${s.i + 1}">Suivante</button>`}</div>
    </div>
  </section>`
}
// La réponse en cours de saisie (le texte libre passe avant l'option cochée).
function noterReponse() {
  const s = etat.questions
  if (!s) return
  const libre = $("#question-libre")?.value.trim()
  const coche = document.querySelector("input[name=question]:checked")
  s.reponses[s.i] = libre ? { libre } : coche ? { option: Number(coche.value) } : s.reponses[s.i] ?? {}
}

// Le plan, à lire d'abord : pour chaque lot, ce qu'on pourra faire et les fonctions ; les critères
// se déplient. L'éditeur détaillé reste à un clic (« Modifier en détail »).
function blocPlanLecture(p) {
  const plan = p.plan
  const d = plan.design
  const e = p.estimation
  const nb = plan.lots.reduce((n, l) => n + l.taches.length, 0)
  return html`
    <div class="colonnes">
      <div class="colonne-large">
        ${plan.sens?.promesse ? html`<section class="carte carte-p pile"><div class="surtitre">Ce que le produit change</div><p style="margin:0;font-size:17px;font-weight:600">${plan.sens.promesse}</p>${plan.sens.moment ? html`<div class="aide">${plan.sens.moment}</div>` : ""}</section>` : ""}
        ${plan.lots.map((lot, i) => html`<section class="carte carte-p pile" aria-label="Lot ${i + 1}">
          <div class="mono aide">LOT ${i + 1} · ${lot.taches.length} fonction${lot.taches.length > 1 ? "s" : ""}</div>
          ${lot.objectif ? html`<div><div class="aide">À la fin de ce lot</div><h2 style="font-size:17px">${lot.objectif}</h2></div>` : html`<h2 style="font-size:17px">${lot.nom}</h2>`}
          <ul class="fonctions">${lot.taches.map((t) => html`<li>${t.titre}</li>`)}</ul>
          <details><summary class="aide" style="cursor:pointer">Ce qui sera vérifié · ${lot.taches.reduce((n, t) => n + t.criteres.length, 0)} critère(s)</summary>
            <ul class="criteres-lecture">${lot.taches.map((t) => t.criteres.map((c) => html`<li><span class="aide">${t.titre} :</span> ${c}</li>`))}</ul></details>
        </section>`)}
        ${plan.hors_perimetre?.length ? html`<div class="aide"><strong>Pas dans ce plan :</strong> ${plan.hors_perimetre.join(" · ")}</div>` : ""}
      </div>
      <aside class="colonne-etroite" aria-label="Décision sur le plan">
        <div class="sombre pile">
          <div class="aide">${BRIQUES[plan.brique ?? "webapp"] ?? "Application reprise"} · ${plan.lots.length} lots · ${nb} fonctions</div>
          ${e?.disponible ? html`<div style="font-size:14px">Estimation : <strong>${e.cout}</strong> · <strong>${e.duree}</strong> de calcul</div><div class="aide">d'après les ${e.mesurees} fonctions déjà fabriquées par l'usine</div>` : ""}
          <button type="button" class="btn" style="background:var(--fond);color:var(--encre)" data-action="valider-plan">Valider le plan et lancer</button>
          <div class="aide">Première validation. La seconde viendra sur le produit fini.</div>
        </div>
        <div class="carte carte-p pile">
          <label class="titre-champ" for="revision">Demander un changement</label>
          <textarea id="revision" class="champ" rows="3" placeholder="Ex. : la signature du client n'est pas utile, mais il faut un mode sombre."></textarea>
          <div><button type="button" class="btn btn-s" data-action="message" data-source="revision">Envoyer à l'analyste</button></div>
        </div>
        ${d ? html`<div class="carte carte-p pile"><strong>Brief de design</strong><p style="margin:0;font-size:14px;color:var(--texte)">${d.intention ?? ""}</p>
          ${d.palette ? html`<div class="palette-couleurs" aria-label="Palette">${Object.entries(d.palette).slice(0, 6).map(([k, v]) => html`<span title="${k} ${v}" style="background:${/^#[0-9a-f]{3,8}$/i.test(v) ? v : "transparent"}"></span>`)}</div>` : ""}</div>` : ""}
        <div class="rangee"><button type="button" class="btn btn-s btn-petit" data-action="plan-vue" data-id="edition">Modifier en détail</button><button type="button" class="lien-btn" data-action="confirmer" data-quoi="abandonner">Abandonner ce plan</button></div>
      </aside>
    </div>`
}

// Le plan en cours de modification (une copie, tant qu'il n'est pas enregistré).
const planAffiche = (p) => (etat.planEdition && etat.planEditionId === p.id ? etat.planEdition : p.plan)
const petitBouton = (action, attrs, texte, libelle) => html`<button type="button" class="btn-icone" data-action="${action}" ${brut(attrs)} aria-label="${libelle}" title="${libelle}">${texte}</button>`

function blocPlan(p) {
  const plan = planAffiche(p)
  if (!plan?.lots?.length) return ""
  const d = plan.design
  const e = p.estimation
  const nb = plan.lots.reduce((n, l) => n + l.taches.length, 0)
  return html`
    <div class="colonnes">
      <form class="colonne-large" data-form="plan">
        <div class="barre"><p class="aide" style="margin:0;flex:1;min-width:260px">Tout est modifiable : titres, descriptions, critères, dépendances, ordre des tâches et des lots. Les critères doivent rester observables sur l'application en marche. Les numéros se recalculent seuls.</p>
          ${etat.planModifie ? "" : html`<button type="button" class="btn btn-s btn-petit" data-action="plan-vue" data-id="lecture">Revenir à la lecture</button>`}</div>
        ${plan.lots.map((lot, i) => html`<section class="carte lot" aria-label="Lot ${i + 1}">
          <div class="lot-tete">
            <span class="mono aide">LOT ${i + 1}</span>
            <div style="flex:1;min-width:220px">
              <input class="champ-discret" style="font-weight:600;font-size:16px" aria-label="Nom du lot ${i + 1}" data-lot="${i}" data-champ="nom" value="${lot.nom}">
              <input class="champ-discret aide" style="font-size:14px" aria-label="Objectif du lot ${i + 1}" placeholder="Ce que l'utilisateur peut faire à la fin du lot" data-lot="${i}" data-champ="objectif" value="${lot.objectif ?? ""}">
            </div>
            <span class="outils">${petitBouton("monter-lot", `data-lot="${i}"`, "↑", `Monter le lot ${i + 1}`)}${petitBouton("descendre-lot", `data-lot="${i}"`, "↓", `Descendre le lot ${i + 1}`)}${petitBouton("supprimer-lot", `data-lot="${i}"`, "✕", `Supprimer le lot ${i + 1}`)}</span>
          </div>
          <div style="padding:6px 8px">${lot.taches.map((t, j) => html`<div class="tache-plan">
            <span class="cle mono">${t.cle}</span>
            <div style="flex:1;min-width:0">
              <input class="champ-discret" style="font-weight:600" aria-label="Titre de ${t.cle}" data-lot="${i}" data-tache="${j}" data-champ="titre" value="${t.titre}">
              <textarea class="champ-discret" rows="2" style="font-size:14px;color:var(--texte);resize:vertical" aria-label="Description de ${t.cle}" placeholder="Ce qu'il faut construire, précisément" data-lot="${i}" data-tache="${j}" data-champ="description">${t.description ?? ""}</textarea>
              <ul class="criteres">${t.criteres.map((c, k) => html`<li><span style="color:var(--ok-point)" aria-hidden="true">✓</span><input class="champ-discret" style="padding:5px 8px" aria-label="Critère ${k + 1} de ${t.cle}" data-lot="${i}" data-tache="${j}" data-critere="${k}" value="${c}">${petitBouton("supprimer-critere", `data-lot="${i}" data-tache="${j}" data-critere="${k}"`, "✕", `Retirer le critère ${k + 1} de ${t.cle}`)}</li>`)}</ul>
              <div class="rangee" style="padding-left:12px">
                <button type="button" class="lien-btn" style="padding-left:0" data-action="ajouter-critere" data-lot="${i}" data-tache="${j}">+ Ajouter un critère</button>
                <label class="aide" style="display:flex;align-items:center;gap:6px">après <input class="champ-discret mono" style="width:110px;padding:4px 8px" placeholder="aucune" aria-label="Tâches dont ${t.cle} dépend" data-lot="${i}" data-tache="${j}" data-champ="depend" value="${(t.depend_de ?? []).join(", ")}"></label>
              </div>
            </div>
            <span class="outils" style="flex-direction:column">${petitBouton("monter-tache", `data-lot="${i}" data-tache="${j}"`, "↑", `Monter ${t.cle}`)}${petitBouton("descendre-tache", `data-lot="${i}" data-tache="${j}"`, "↓", `Descendre ${t.cle}`)}${petitBouton("supprimer-tache", `data-lot="${i}" data-tache="${j}"`, "✕", `Supprimer ${t.cle}`)}</span>
          </div>`)}
          <button type="button" class="lien-btn" style="margin:0 0 8px 52px" data-action="ajouter-tache" data-lot="${i}">+ Ajouter une tâche au lot ${i + 1}</button></div>
        </section>`)}
        <div><button type="button" class="btn btn-s btn-petit" data-action="ajouter-lot">+ Ajouter un lot</button></div>
        <div class="rangee"><button type="submit" class="btn btn-p" ${etat.planModifie ? "" : "disabled"}>Enregistrer les modifications</button>${etat.planModifie ? html`<span class="aide">Modifications non enregistrées</span><button type="button" class="lien-btn" data-action="annuler-plan">Tout annuler</button>` : ""}</div>
        <div class="carte carte-p pile">
          <label class="titre-champ" for="revision">Ou demander une révision à l'analyste</label>
          <textarea id="revision" class="champ" rows="3" placeholder="Ex. : la signature du client n'est pas utile, mais il faut un mode sombre."></textarea>
          <div><button type="button" class="btn btn-s" data-action="message" data-source="revision">Envoyer à l'analyste</button></div>
        </div>
      </form>
      <aside class="colonne-etroite" aria-label="Brief et décision">
        ${p.pieces?.length ? html`<div class="carte carte-p pile"><strong>Pièces jointes</strong>${p.pieces.map((x) => html`<div class="aide mono">${x.nom} · ${Math.ceil(x.taille / 1024)} Ko</div>`)}<div class="aide">Lues par l'analyste ; copiées dans docs/maquettes/ du dépôt pour les agents.</div></div>` : ""}
        ${d ? html`<div class="carte carte-p pile"><strong>Brief de design</strong><p style="margin:0;font-size:14px;color:var(--texte)">${d.intention ?? ""}</p>
          ${d.palette ? html`<div class="palette-couleurs" aria-label="Palette">${Object.entries(d.palette).slice(0, 6).map(([k, v]) => html`<span title="${k} ${v}" style="background:${/^#[0-9a-f]{3,8}$/i.test(v) ? v : "transparent"}"></span>`)}</div>` : ""}
          ${d.typographie ? html`<div class="aide">Polices : ${[d.typographie.titres, d.typographie.texte].filter(Boolean).join(" · ")}</div>` : ""}</div>` : ""}
        ${plan.hors_perimetre?.length || plan.risques?.length ? html`<div class="carte carte-p pile" style="font-size:14px">
          ${plan.hors_perimetre?.length ? html`<strong>Hors périmètre</strong><div style="color:var(--texte)">${plan.hors_perimetre.join(" · ")}</div>` : ""}
          ${plan.risques?.length ? html`<strong>Risques</strong><div style="color:var(--texte)">${plan.risques.join(" · ")}</div>` : ""}</div>` : ""}
        <div class="sombre pile">
          <div class="aide">${BRIQUES[plan.brique ?? "webapp"]} · ${plan.lots.length} lots · ${nb} tâches</div>
          ${e?.disponible ? html`<div style="font-size:14px">Estimation : <strong>${e.cout}</strong> en équivalent API · <strong>${e.duree}</strong> de calcul</div><div class="aide">d'après les ${e.mesurees} tâches déjà fabriquées par l'usine (${e.par_tache} par tâche en moyenne)</div>` : ""}
          <button type="button" class="btn" style="background:var(--fond);color:var(--encre)" data-action="valider-plan" ${etat.planModifie ? "disabled" : ""}>Valider le plan et lancer</button>
          <div class="aide">${etat.planModifie ? "Enregistre d'abord tes modifications." : "Première porte humaine. La seconde viendra au produit fini."}</div>
          <button type="button" class="lien-btn" style="color:inherit;opacity:.8;align-self:flex-start;padding-left:0" data-action="confirmer" data-quoi="abandonner">Abandonner ce plan</button>
        </div>
      </aside>
    </div>`
}

function ongletActif(p) {
  const enCours = p.taches.some((t) => ["en_cours", "verification"].includes(t.statut))
  const o = etat.onglet ?? (enCours ? "direct" : "journal")
  return o === "direct" && !enCours ? "journal" : o
}

function blocFabrication(p) {
  const plan = p.plan ?? { lots: [] }
  const enCours = p.taches.find((t) => ["en_cours", "verification"].includes(t.statut))
  const onglet = ongletActif(p)
  const lotCourant = enCours?.lot ?? Math.min(plan.lots.length, p.lot_livre + 1)
  const tachesLot = p.taches.filter((t) => t.lot === lotCourant)
  const STT = { fusionnee: ["ajoutée", "ok"], en_cours: ["en cours", "actif"], verification: ["essayée", "actif"], prete: ["à faire", ""], attente: ["à faire", ""], bloquee: ["à décider", "actif"], abandonnee: ["retirée", ""] }
  const discussion = p.journal.filter((j) => ["demande", "decision", "corrections", "diagnostic", "validation", "plan", "design", "abandon", "production", "domaine"].includes(j.type))
  const essai = enCours && (enCours.approche || enCours.tentative)
  return html`
    <div class="volets">
      <div class="volet">
        <section class="carte carte-p pile" style="gap:14px" aria-labelledby="en-ce-moment">
          ${enCours ? html`
            <div class="surtitre" id="en-ce-moment">En ce moment · lot ${lotCourant} sur ${plan.lots.length}</div>
            <strong style="font-size:17px">Je construis : ${enCours.titre}</strong>
            ${essai ? html`<span class="aide">${enCours.approche ? `Méthode ${enCours.approche + 1}` : `Essai ${enCours.tentative + 1}`} : la version précédente a été refusée par le contrôle, l'usine la reprend.</span>` : ""}
            ${etapesTache(enCours, p.etapes_noms ?? [])}`
          : html`<strong id="en-ce-moment">${p.statut === "en_production" ? "En ligne" : p.statut === "livre" ? "Tous les lots sont livrés" : p.statut === "creation" ? "L'usine prépare le dépôt et le socle" : "Aucune fonction en cours"}</strong>${p.statut === "fabrication" ? html`<span class="aide">L'usine passe à la suite.</span>` : ""}`}
          <details class="technique" id="technique" ${etat.techniqueOuvert ? "open" : ""}><summary>Détail technique : direct, journal, pull requests</summary>
            <div class="pile" style="margin-top:12px">
              ${enCours ? html`<div class="aide mono">${enCours.cle}${enCours.pr ? ` · PR #${enCours.pr}` : ""}${enCours.approche ? ` · approche ${enCours.approche + 1}, modèle renforcé` : enCours.tentative ? ` · correction ${enCours.tentative}` : ""}</div>` : ""}
              <div class="onglets" role="tablist" aria-label="Détail technique">
                ${[...(enCours ? [["direct", "● En direct"]] : []), ["journal", "Journal"]].map(([id, nom]) => html`<button type="button" role="tab" id="onglet-${id}" aria-controls="panneau" aria-selected="${String(onglet === id)}" tabindex="${onglet === id ? "0" : "-1"}" data-action="onglet" data-id="${id}">${nom}</button>`)}
              </div>
              <div role="tabpanel" id="panneau" aria-labelledby="onglet-${onglet}">
              ${onglet === "direct" ? html`<div class="direct mono" role="log" aria-live="off" id="direct">${dessinerDirect()}</div>
                <div class="aide">${enCours.statut === "verification" ? "Le vérificateur reconstruit l'application et teste les critères." : "L'agent code dans son atelier."} Mis à jour toutes les 3 secondes ; les secrets sont masqués.</div>` : ""}
              ${onglet === "journal" ? html`<div class="journal mono" role="log" aria-live="polite" id="journal">
                ${p.journal.map((j) => html`<div class="t-${j.type}"><time>${heure(j.le)}</time>${j.type} · ${nettoyer(j.message.length > 600 ? j.message.slice(0, 600) + "…" : j.message)}</div>`)}
                ${p.etapes.length ? html`<div style="margin-top:8px;color:var(--code-doux)">— suivi —</div>${p.etapes.map((e) => html`<div>${e}</div>`)}` : ""}
              </div>` : ""}
              </div>
            </div>
          </details>
        </section>
        <section class="carte carte-p pile" style="gap:12px" aria-labelledby="fil-titre">
          <h2 id="fil-titre" style="font-size:15px">Le fil</h2>
          ${discussion.slice(-12).map((j) => html`<div class="bulle ${j.type === "demande" || j.type === "decision" ? "moi" : "usine"}"><small>${j.type === "demande" || j.type === "decision" ? "Toi" : "L'usine"} · ${heure(j.le)}</small>${nettoyer(j.message.length > 600 ? j.message.slice(0, 600) + "…" : j.message)}</div>`)}
          <div class="rangee" style="flex-wrap:nowrap"><label class="cache" for="message-libre">Message à l'usine</label>
            <input id="message-libre" class="champ" placeholder="Une précision pour l'usine…">
            <button type="button" class="btn btn-p" data-action="message" data-source="message-libre">Envoyer</button></div>
          <div class="aide">Pendant la fabrication, une précision part avec la prochaine livraison. Pour changer de cap : « Changer de direction ».</div>
        </section>
      </div>
      <div class="volet">
        ${blocProduit(p)}
        ${tachesLot.length ? html`<section class="carte carte-p"><h2 style="font-size:15px;margin-bottom:10px">Lot ${lotCourant} · ${plan.lots[lotCourant - 1]?.nom ?? ""}</h2>
          <ul class="taches">${tachesLot.map((t) => html`<li><span class="titre">${t.titre}</span><span class="st ${(STT[t.statut] ?? ["", ""])[1]}">${(STT[t.statut] ?? [t.statut])[0]}</span></li>`)}</ul></section>` : ""}
      </div>
    </div>`
}

// Le produit, à droite : les captures du contrôle (ordinateur et mobile), lot par lot, et le lien
// vers l'aperçu. Pas de cadre intégré : les produits et le portier refusent d'être affichés dans
// une autre page, c'est leur protection.
function blocProduit(p) {
  const plan = p.plan ?? { lots: [] }
  const lotsAvecCaptures = [...new Set(p.captures.map((c) => c.lot).filter(Boolean))].sort((a, b) => a - b)
  if (etat.produit.projet !== p.id) etat.produit = { projet: p.id, lot: null, i: 0 }
  const lot = etat.produit.lot ?? lotsAvecCaptures.at(-1) ?? null
  const caps = p.captures.filter((c) => c.lot === lot)
  const i = Math.min(etat.produit.i, Math.max(0, caps.length - 1))
  const c = caps[i]
  const adresse = p.production ?? p.apercu
  return html`<section class="carte carte-p pile produit" style="gap:12px" aria-labelledby="produit-titre">
    <div class="barre"><h2 id="produit-titre" style="font-size:15px">Le produit</h2>${adresse ? html`<a class="btn btn-s btn-petit" href="${adresse}" target="_blank" rel="noopener">${p.production ? "Ouvrir le produit" : "Ouvrir l'aperçu"}</a>` : ""}</div>
    <ol class="lots" aria-label="Lots">${plan.lots.map((l, j) => {
      const n = j + 1
      const cls = n <= p.lot_livre ? "livre" : n === Math.min(plan.lots.length, p.lot_livre + 1) && ["fabrication", "corrections", "creation"].includes(p.statut) ? "courant" : ""
      return lotsAvecCaptures.includes(n)
        ? html`<li class="mono ${cls}"><button type="button" data-action="produit-lot" data-id="${n}" aria-pressed="${String(lot === n)}" title="Lot ${n} : ${l.nom}">${n}</button></li>`
        : html`<li class="mono ${cls}" title="Lot ${n} : ${l.nom}">${n}</li>`
    })}</ol>
    ${c ? html`<figure class="capture-grande"><a href="${c.url}" target="_blank" rel="noopener"><img src="${c.url}" alt="Capture du lot ${lot} : ${c.fichier}"></a>
        <figcaption>Lot ${lot} · ${plan.lots[lot - 1]?.nom ?? ""} · ${i + 1} sur ${caps.length}</figcaption></figure>
      ${caps.length > 1 ? html`<div class="rangee"><button type="button" class="btn btn-s btn-petit" data-action="produit-capture" data-id="${(i - 1 + caps.length) % caps.length}" aria-label="Capture précédente">←</button><button type="button" class="btn btn-s btn-petit" data-action="produit-capture" data-id="${(i + 1) % caps.length}" aria-label="Capture suivante">→</button></div>` : ""}`
    : html`<div class="vide">${p.lot_livre ? "Pas de capture pour ce lot." : "Le produit apparaîtra ici dès le premier lot livré : le contrôle prend des captures, sur ordinateur et sur mobile, de chaque fonction vérifiée."}</div>`}
  </section>`
}

// La mise en ligne : les réglages en une phrase (modifiables), puis un seul bouton.
const LIBELLES_PROD = {
  donnees: { vide: "Base vide", demo: "Données de démo" },
  emails: { captures: "Capturés : rien ne part", reels: "Réels, vers les destinataires autorisés" },
  acces: { protege: "Protégé par la page de connexion", public: "Public, sans connexion" },
  horloge: { reelle: "Réelle", acceleree: "Accélérée (un jour = une minute)" },
}
function blocProduction(p) {
  if (p.statut === "mise_en_production") return html`<div class="message info pile" style="align-items:flex-start"><strong>Mise en ligne en cours</strong>
    <span>Sauvegarde des données, construction de la dernière version vérifiée, bascule sans coupure. Cette page se met à jour toute seule.</span></div>`
  if (!["livre", "en_production"].includes(p.statut)) return ""
  const c = p.production_choix ?? {}
  const radio = (nom, val, titre, sous) => html`<label class="choix"><input type="radio" name="${nom}" value="${val}" ${c[nom] === val ? "checked" : ""}><span><strong>${titre}</strong>${sous ? html`<br><span class="aide">${sous}</span>` : ""}</span></label>`
  const enProd = p.statut === "en_production"
  return html`
    <div class="colonnes">
      <section class="carte carte-p colonne-large" aria-labelledby="prod" style="gap:18px">
        <h2 id="prod">${enProd ? "Réglages de la production" : "Mettre en ligne"}</h2>
        <form class="pile" style="gap:16px" data-form="production">
          <dl class="recap">${Object.entries(LIBELLES_PROD).map(([cle, l]) => html`<dt>${{ donnees: "Données", emails: "Emails", acces: "Accès", horloge: "Horloge" }[cle]}</dt><dd>${l[c[cle]] ?? "—"}${cle === "emails" && c.emails === "reels" && c.destinataires_autorises?.length ? ` (${c.destinataires_autorises.join(", ")})` : ""}</dd>`)}</dl>
          <div class="pile" style="gap:16px" id="prod-reglages" ${etat.prodReglages ? "" : "hidden"}>
            <fieldset><legend>Données au démarrage</legend><div class="grille">${radio("donnees", "vide", "Base vide", "les vraies données arrivent avec l'usage")}${radio("donnees", "demo", "Données de démo", "pour une présentation")}</div></fieldset>
            <fieldset><legend>Emails</legend><div class="grille">${radio("emails", "captures", "Capturés", "rien ne part, visibles dans Mailpit")}${radio("emails", "reels", "Réels, destinataires autorisés", "seulement vers la liste ci-dessous")}</div>
              <label class="aide" for="destinataires">Destinataires autorisés (adresses ou @domaine, séparés par des virgules)</label>
              <input id="destinataires" name="destinataires_autorises" class="champ" value="${(c.destinataires_autorises ?? []).join(", ")}"></fieldset>
            <fieldset><legend>Accès</legend><div class="grille">${radio("acces", "protege", "Protégé", "page de connexion de l'usine")}${radio("acces", "public", "Public", "ouvert à tous, sans connexion")}</div></fieldset>
            <fieldset><legend>Horloge</legend><div class="grille">${radio("horloge", "reelle", "Réelle")}${radio("horloge", "acceleree", "Accélérée", "un jour = une minute (démo)")}</div></fieldset>
          </div>
          <div><button type="button" class="lien-btn" style="padding-left:0" data-action="prod-reglages">${etat.prodReglages ? "Masquer les réglages" : "Modifier les réglages"}</button></div>
          <div class="confirmer" role="alertdialog" aria-labelledby="conf-prod" id="conf-production" hidden>
            <strong id="conf-prod" style="font-size:16px">${enProd ? `Appliquer ces réglages à ${p.nom} ?` : `Mettre ${p.nom} en ligne ?`}</strong>
            <ul style="margin:0;padding-left:18px;font-size:14px;color:var(--texte)"><li>Dernière version vérifiée, avec les réglages ci-dessus.</li><li>Bascule sans coupure ; sauvegarde des données avant.</li><li>Ta validation est tracée dans le dépôt d'état.</li></ul>
            <div class="rangee"><button type="submit" class="btn btn-p">${enProd ? "Oui, appliquer" : "Oui, mettre en ligne"}</button><button type="button" class="btn btn-s" data-action="annuler" data-quoi="production">Annuler</button></div>
          </div>
          <div class="rangee" id="btn-production"><button type="button" class="btn btn-p" data-action="confirmer" data-quoi="production">${enProd ? "Appliquer en production" : "Mettre en ligne"}</button></div>
        </form>
        <div class="pile" style="border-top:1px solid var(--trait-2);padding-top:16px">
          <label class="titre-champ" for="corrections">Demander des corrections</label>
          <textarea id="corrections" class="champ" rows="3" placeholder="Ce qui ne va pas, ce qui manque. L'analyste enquête (journaux, réglages) et ajoute un lot."></textarea>
          <div><button type="button" class="btn btn-s" data-action="corriger">Envoyer à l'analyste</button></div>
        </div>
      </section>
      <aside class="colonne-etroite" aria-label="Adresses et durée de vie">
        <section class="carte carte-p pile" aria-labelledby="domaines">
          <h2 id="domaines" style="font-size:15px">Adresses</h2>
          ${p.production ? html`<div style="font-size:14px"><span class="aide">Usine :</span> <a class="mono" href="${p.production}" target="_blank" rel="noopener">${p.production.replace(/^https?:\/\//, "")}</a></div>` : ""}
          ${p.domaines_liste.map((d) => html`<div class="pile" style="border:1px solid ${d.statut === "actif" ? "var(--trait)" : "var(--signal-trait)"};border-radius:10px;padding:12px;gap:8px">
            <div class="barre"><span class="mono" style="font-weight:500">${d.hote}</span>${d.statut === "actif" ? html`<span class="badge vert">actif</span>` : d.statut === "certificat" ? html`<span class="badge bleu">certificat en cours</span>` : html`<span class="badge orange">en attente du DNS</span>`}</div>
            ${d.statut === "attente_dns" ? html`<div style="font-size:13px">Crée cet enregistrement chez ton fournisseur de domaine :</div>
              <div class="dns mono"><span>type</span><span>nom</span><span>valeur</span><span>A</span><span>${d.hote.split(".").length > 2 ? d.hote.split(".").slice(0, -2).join(".") : "@"}</span><span>${p.ip_serveur ?? "IP du serveur"}</span></div>
              <div class="aide">${d.message ?? "vérifié toutes les 2 minutes"}</div>` : ""}
            <div><button type="button" class="btn btn-d btn-petit" data-action="retirer-domaine" data-hote="${d.hote}">Retirer</button></div>
          </div>`)}
          ${enProd ? html`<form class="rangee" style="flex-wrap:nowrap" data-form="domaine"><label class="cache" for="hote">Nouveau domaine</label><input id="hote" name="hote" class="champ" placeholder="app.mon-entreprise.fr"><button type="submit" class="btn btn-s">Ajouter</button></form>` : html`<div class="aide">Un domaine personnalisé s'ajoute une fois le produit en ligne.</div>`}
        </section>
        ${p.apercu ? html`<section class="carte carte-p pile"><h2 style="font-size:15px">Aperçu</h2>
          <div style="font-size:14px">${p.apercu_garde ? "Gardé sans limite de durée." : `Durée de vie : ${p.apercu_vie}.`}</div>
          <div class="rangee"><button type="button" class="btn btn-s btn-petit" data-action="apercu" data-quoi="prolonger">Prolonger</button>${p.apercu_garde ? "" : html`<button type="button" class="btn btn-s btn-petit" data-action="apercu" data-quoi="garder">Garder</button>`}<button type="button" class="btn btn-d btn-petit" data-action="apercu" data-quoi="retirer">Retirer</button></div></section>` : ""}
      </aside>
    </div>`
}

// Le produit est en ligne : l'adresse et ce qu'on fait ensuite.
function blocEnLigne(p) {
  if (p.statut !== "en_production" || !p.production) return ""
  return html`<section class="en-ligne" aria-labelledby="en-ligne-titre">
    <div class="pile" style="gap:6px;min-width:0"><h2 id="en-ligne-titre">${p.nom} est en ligne</h2><span class="url mono">${p.production.replace(/^https?:\/\//, "")}</span></div>
    <div class="rangee">
      <a class="btn btn-blanc" href="${p.production}" target="_blank" rel="noopener">Ouvrir</a>
      <button type="button" class="btn btn-voile" data-action="copier" data-texte="${p.production}">Copier l'adresse</button>
      <a class="btn btn-voile" href="#/reglages/equipe">Inviter des utilisateurs</a>
      <button type="button" class="btn btn-voile" data-action="aller" data-cible="hote">Ajouter un domaine</button>
      ${p.video?.fichier ? "" : html`<button type="button" class="btn btn-voile" data-action="video">Générer la vidéo</button>`}
    </div>
  </section>`
}

// La vidéo de présentation du projet : un bouton, et la vidéo quand elle est prête.
function blocVideo(p) {
  if (!p.plan?.lots?.length) return ""
  const v = p.video ?? { etat: "aucune" }
  const src = `/api/projets/${p.id}/video.mp4?v=${encodeURIComponent(v.fichier?.le ?? "")}`
  return html`<section class="carte carte-p pile" aria-labelledby="video-titre" style="gap:14px">
    <div class="barre"><div><h2 id="video-titre">Vidéo de présentation</h2><div class="aide">Une minute pour montrer le produit : le besoin, les fonctionnalités avec les vraies captures, les chiffres, l'adresse.</div></div>
      ${v.etat === "en_cours" ? html`<span class="badge bleu">Génération en cours…</span>` : html`<button type="button" class="btn ${v.fichier ? "btn-s" : "btn-p"}" data-action="video">${v.fichier ? "Regénérer la vidéo" : "Générer la vidéo de présentation"}</button>`}</div>
    ${v.etat === "en_cours" ? html`<div class="aide">Le rendu se fait sur le serveur dès que le vérificateur est libre, en quelques minutes. Cette page se met à jour toute seule.</div>` : ""}
    ${v.etat === "erreur" ? html`<div class="message erreur">La génération a échoué : ${v.message ?? "erreur inconnue"}</div>` : ""}
    ${v.fichier ? html`<video controls preload="metadata" src="${src}" style="width:100%;max-width:960px;border-radius:12px;background:#000"></video>
      <div class="rangee"><a class="btn btn-s btn-petit" href="${src}&telecharger=1" download>Télécharger (${Math.round(v.fichier.taille / 1024 / 1024 * 10) / 10} Mo)</a><span class="aide">générée le ${heure(v.fichier.le)}</span></div>` : ""}
  </section>`
}

// Un projet en échec : la dernière erreur, et la relance là où il s'est arrêté.
function blocEchec(p) {
  const derniere = [...(p.journal ?? [])].reverse().find((x) => x.type === "erreur")
  const creation = p.plan?.lots?.length && (p.journal ?? []).some((x) => x.type === "validation")
  return html`<div class="message erreur pile" style="align-items:flex-start">
    <span><strong>${creation ? "La création du produit a échoué." : "L'analyse a échoué."}</strong> ${derniere ? derniere.message.slice(0, 600) : "Raison inconnue : voir l'historique."}</span>
    <span class="aide">${creation ? "Relancer reprend avec le plan déjà validé : rien à refaire de ton côté." : "Relancer repart de ta demande d'origine."}</span>
    <div><button type="button" class="btn btn-p btn-petit" data-action="relancer-projet">Relancer</button></div>
  </div>`
}

// Changer de direction pendant la fabrication : l'usine finit la tâche en cours, garde ce qui est
// fabriqué, et l'analyste propose la suite du plan, à valider.
function blocReorienter(p) {
  if (!["fabrication", "bloque"].includes(p.statut)) return ""
  const liste = personasValides()
  return html`<details class="carte carte-p" id="reorienter" ${etat.reorienterOuvert ? "open" : ""}><summary style="cursor:pointer;font-weight:600">Changer de direction</summary>
    <div class="pile" style="margin-top:12px">
      <p class="aide" style="margin:0">L'usine termine la tâche en cours, puis l'analyste refait la suite du plan pour cette nouvelle direction. Ce qui est déjà fabriqué est gardé ; les tâches pas encore faites sont reprises ou laissées. Tu valides le nouveau plan avant que la fabrication reprenne, ou tu gardes l'ancien.</p>
      <label class="titre-champ" for="consigne-reorienter">La nouvelle direction</label>
      <textarea id="consigne-reorienter" class="champ" rows="4" placeholder="Ex. : on vise les artisans plutôt que les agences ; la facturation n'est plus utile, il faut un agenda partagé."></textarea>
      <label class="titre-champ" for="persona-reorienter">Persona <span class="aide" style="font-weight:400">· facultatif : pour viser un autre public</span></label>
      <select id="persona-reorienter" class="champ">
        <option value="">${p.persona ? `Garder « ${p.persona} »` : "Sans persona"}</option>
        ${liste.filter((x) => x.id !== p.persona_id).map((x) => html`<option value="${x.id}">${x.nom}</option>`)}
      </select>
      <div><button type="button" class="btn btn-p" data-action="reorienter">Réorienter le projet</button></div>
    </div></details>`
}

// Le nouveau plan d'une réorientation : les lots gardés en rappel, la suite en détail.
// Il se révise par l'analyste (ses clés désignent des tâches qui existent déjà).
function blocPlanReorientation(p) {
  const plan = p.plan
  const r = p.reorientation
  const garde = r.garde ?? 0
  const nouveaux = plan.lots.slice(garde)
  return html`
    <div class="colonnes">
      <div class="colonne-large pile">
        <div class="message info pile" style="align-items:flex-start"><span><strong>Réorientation demandée${r.par ? ` par ${r.par}` : ""}.</strong> ${r.consigne}</span>
          ${r.persona ? html`<span class="aide">Nouveau persona : ${r.persona}</span>` : ""}</div>
        ${garde ? html`<section class="carte carte-p pile"><strong>Gardé (déjà fabriqué)</strong>
          <ol style="margin:0;padding-left:20px">${plan.lots.slice(0, garde).map((l) => html`<li>${l.nom}</li>`)}</ol></section>` : ""}
        ${r.abandonnees.length ? html`<div class="aide">À la validation, les fonctions pas encore construites de l'ancien plan seront laissées de côté (${r.abandonnees.length}).</div>` : ""}
        ${nouveaux.map((lot, j) => html`<section class="carte lot" aria-label="Lot ${garde + j + 1}">
          <div class="lot-tete"><span class="mono aide">LOT ${garde + j + 1}</span><div style="flex:1;min-width:220px"><strong>${lot.nom}</strong><div class="aide">${lot.objectif ?? ""}</div></div></div>
          <div style="padding:6px 8px">${lot.taches.map((t) => html`<div class="tache-plan"><span class="cle mono">${t.cle}</span><div style="flex:1;min-width:0">
            <strong>${t.titre}</strong>${t.depend_de?.length ? html`<span class="aide"> · après ${t.depend_de.join(", ")}</span>` : ""}
            <div style="font-size:14px;color:var(--texte)">${t.description ?? ""}</div>
            <ul class="criteres">${t.criteres.map((c) => html`<li><span style="color:var(--ok-point)" aria-hidden="true">✓</span><span>${c}</span></li>`)}</ul></div></div>`)}</div>
        </section>`)}
        <div class="carte carte-p pile">
          <label class="titre-champ" for="revision">Demander une révision à l'analyste</label>
          <textarea id="revision" class="champ" rows="3" placeholder="Ex. : garde l'export PDF, et commence par l'agenda."></textarea>
          <div><button type="button" class="btn btn-s" data-action="message" data-source="revision">Envoyer à l'analyste</button></div>
        </div>
      </div>
      <aside class="colonne-etroite" aria-label="Décision">
        <div class="sombre pile">
          <div class="aide">${garde} lot(s) gardé(s) · ${nouveaux.length} nouveau(x) · ${nouveaux.reduce((n, l) => n + l.taches.length, 0)} tâche(s)</div>
          <button type="button" class="btn" style="background:var(--fond);color:var(--encre)" data-action="valider-plan">Valider la réorientation</button>
          <div class="aide">La fabrication reprend au lot ${garde + 1}.</div>
          <button type="button" class="lien-btn" style="color:inherit;opacity:.8;align-self:flex-start;padding-left:0" data-action="annuler-reorientation">Garder l'ancien plan</button>
        </div>
      </aside>
    </div>`
}

function vueProjet() {
  const p = etat.projet
  if (!p || p.id !== etat.route.id) return html`${barreHaut()}<div class="chargement">Chargement du projet…</div>`
  const enPlan = p.statut === "plan_a_valider"
  return html`
    ${barreHaut()}
    <div class="entete">
      <div><a class="retour" href="#/">← Projets</a>
        <div class="rangee" style="margin-top:8px;gap:12px"><h1>${p.nom}</h1>${pastilleAttente(p)}${["echec", "arrete", "abandonne"].includes(p.statut) ? badgeStatut(p.statut) : ""}${p.brique ? html`<span class="badge">${BRIQUES[p.brique] ?? p.brique}</span>` : ""}${p.repris ? html`<span class="badge">Application reprise</span>` : ""}${p.persona ? html`<a class="badge bleu" href="#/personas/${p.persona_id}" style="text-decoration:none">Persona : ${p.persona}</a>` : ""}${p.cout ? html`<span class="badge mono" title="Coût estimé au tarif des API${p.budget ? `, sur un budget de ${p.budget}` : ""}">${p.cout}${p.budget ? ` / ${p.budget}` : ""}</span>` : ""}</div>
        <p class="chapeau">${p.resume}</p></div>
      <div class="rangee">
        ${["fabrication", "bloque"].includes(p.statut) ? html`<button type="button" class="btn btn-s" data-action="ouvrir-reorienter" aria-controls="reorienter" aria-expanded="${String(Boolean(etat.reorienterOuvert))}">Changer de direction</button>` : ""}
        ${p.production ? html`<a class="btn btn-s" href="${p.production}" target="_blank" rel="noopener">Ouvrir le produit</a>` : p.apercu ? html`<a class="btn btn-s" href="${p.apercu}" target="_blank" rel="noopener">Ouvrir l'aperçu</a>` : ""}
        ${p.depot ? html`<a class="btn btn-s" href="${p.depot}" target="_blank" rel="noopener">Voir le code</a>` : ""}
      </div>
    </div>
    ${ligneDeVie(p)}
    ${messageGlobal()}
    ${blocEnLigne(p)}
    ${p.escalades.map((e) => blocDecision(p, e))}
    ${p.statut === "analyse" ? html`<div class="message info"><span>${p.repris && !p.inventaire ? "L'usine fait l'inventaire du dépôt (pile, commandes, ce qui marche) et le met au contrat d'hébergement ; puis l'analyste prépare le plan." : "L'analyste étudie la demande et prépare le plan."} Cette page se met à jour toute seule.</span></div>` : ""}
    ${p.statut === "echec" ? blocEchec(p) : ""}
    ${blocReprise(p)}
    ${p.statut === "questions" ? blocQuestions(p) : ""}
    ${p.statut === "reorientation" ? html`<div class="message info pile" style="align-items:flex-start"><span><strong>Réorientation en cours.</strong> L'usine termine la fonction en cours, puis l'analyste refait la suite du plan. Cette page se met à jour toute seule.</span>
      <span class="aide">${p.reorientation?.consigne ?? ""}</span>
      <div class="rangee"><button type="button" class="btn btn-s btn-petit" data-action="relancer-projet">Relancer l'analyste</button><button type="button" class="btn btn-s btn-petit" data-action="annuler-reorientation">Garder l'ancien plan</button></div></div>` : ""}
    ${enPlan ? (p.reorientation ? blocPlanReorientation(p) : etat.planVue === "edition" || etat.planModifie ? blocPlan(p) : blocPlanLecture(p)) : ""}
    ${etat.reorienterOuvert ? blocReorienter(p) : ""}
    ${!enPlan && p.plan?.lots?.length && !["analyse", "questions"].includes(p.statut) ? blocFabrication(p) : ""}
    ${blocRecette(p)}
    ${blocProduction(p)}
    ${blocVideo(p)}
    <details class="carte carte-p" id="zone-sensible" ${etat.detailsOuvert ? "open" : ""}><summary style="cursor:pointer;font-weight:600">La demande d'origine, supprimer le projet</summary>
      <p style="white-space:pre-wrap;color:var(--texte)">${p.prompt}</p>
      <div class="confirmer" role="alertdialog" aria-labelledby="conf-sup" id="conf-supprimer" hidden><strong id="conf-sup">Supprimer ${p.nom} ?</strong>
        <div style="font-size:14px">L'aperçu et la production s'arrêtent et la place est libérée. Le code reste sur GitHub et les données de production restent sur le serveur.</div>
        <div class="rangee"><button type="button" class="btn btn-d" data-action="supprimer">Oui, supprimer le projet</button><button type="button" class="btn btn-s" data-action="annuler" data-quoi="supprimer">Annuler</button></div></div>
      <div id="btn-supprimer"><button type="button" class="btn btn-d btn-petit" data-action="confirmer" data-quoi="supprimer">Supprimer le projet</button></div>
    </details>`
}

// Les services de l'usine, nommés pour tout le monde (le nom technique reste en info-bulle).
const NOMS_SERVICES = {
  orchestrateur: "Le chef d'orchestre", atelier: "L'atelier, où l'IA construit", "vérificateur": "Le contrôle qualité",
  "déployeur": "La mise en ligne des applications", portier: "La page de connexion", "caddy (HTTPS)": "Les adresses web sécurisées",
  mailpit: "La boîte des emails de démonstration", applications: "Les applications en ligne", disque: "L'espace disque du serveur",
  "mémoire": "La mémoire du serveur", GitHub: "GitHub, où le code est rangé", "mises à jour": "Les mises à jour de l'usine",
  "Claude (agents)": "Claude, qui construit", "Codex (vérificateur)": "ChatGPT, qui contrôle",
}
const nomService = (n) => NOMS_SERVICES[n] ?? n.replace(/^Codex/, "ChatGPT")

// L'utilisation, comme une page de crédits (Base44, Gumloop) : où en est le mois, quand il
// repart à zéro, ce que chaque projet a consommé.
function vueUtilisation() {
  const s = etat.sante
  if (!s) return html`<div class="chargement">Chargement…</div>`
  const c = s.couts
  const max = Math.max(1e-9, ...c.evolution.map((e) => Math.max(e.api, e.reel)))
  const suivant = new Date()
  suivant.setMonth(suivant.getMonth() + 1, 1)
  return html`
    <div class="entete"><div><h1>Utilisation</h1><p class="chapeau">Ce que l'IA a consommé ce mois-ci, compté au prix public.</p></div>
      <button type="button" class="btn btn-s" data-action="fenetre" data-quoi="budget">${c.budget ? "Modifier le budget" : "Fixer un budget"}</button></div>
    <section class="carte carte-p pile credits" aria-label="Ce mois-ci">
      <div class="barre" style="align-items:flex-end;flex-wrap:wrap;gap:12px">
        <div><div class="aide">Ce mois-ci</div><div class="chiffre">${c.api}${c.budget ? html`<span> sur ${c.budget}</span>` : ""}</div></div>
        <div class="aide">Remise à zéro le ${suivant.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}</div>
      </div>
      ${c.pct !== null ? html`<div class="jauge ${c.pct >= 80 ? "orange" : "bleue"}" style="height:14px" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, c.pct)}" aria-label="Budget du mois utilisé"><div style="width:${Math.min(100, c.pct)}%"></div></div>
        <div class="aide">${c.pct} % du budget utilisé. L'usine te prévient en approchant de la limite, puis te demande avant de continuer.</div>`
      : html`<div class="aide">Pas de budget mensuel : l'usine dépense sans limite.</div>`}
      <div class="separe aide">Ce que tu paies vraiment ce mois-ci (abonnements et serveur) : <strong>${c.reel}</strong>. C'est souvent bien moins que le prix public.</div>
    </section>
    <section class="carte carte-p pile" aria-labelledby="par-projet">
      <h2 id="par-projet">Par projet</h2>
      ${c.projets.length ? html`<ul class="lignes-conso">${c.projets.map((p) => html`<li>
        <a class="lien-projet" href="#/projets/${p.id}">${p.nom}</a>
        <span class="mono">${p.mesure ? p.api : html`<span class="aide">pas encore mesuré</span>`}</span>
        ${p.budget_pct !== null ? html`<span class="jauge ${p.budget_pct >= 80 ? "orange" : "bleue"}" title="${p.budget_pct} % du budget du projet"><span style="width:${Math.min(100, p.budget_pct)}%"></span></span>` : html`<span></span>`}
        <span class="aide">${p.refus ? `${p.refus} version${p.refus > 1 ? "s" : ""} refaite${p.refus > 1 ? "s" : ""}` : ""}</span></li>`)}</ul>`
      : html`<div class="aide">Aucun projet pour l'instant.</div>`}
    </section>
    <section class="carte carte-p pile" aria-labelledby="par-mois">
      <div class="barre"><h2 id="par-mois">Les six derniers mois</h2><a class="aide" href="/couts">Détail complet</a></div>
      <div class="graph" aria-hidden="true">${c.evolution.map((e) => html`<div title="${e.mois} : ${e.api_texte} au prix public, ${e.reel_texte} payés"><i style="height:${Math.round((e.api / max) * 100)}%"></i><i class="reel" style="height:${Math.round((e.reel / max) * 100)}%"></i></div>`)}</div>
      <div class="graph-legende" aria-hidden="true">${c.evolution.map((e) => html`<span>${e.mois.slice(5)}/${e.mois.slice(2, 4)}</span>`)}</div>
      <div class="rangee aide"><span><span class="badge bleu">■</span> au prix public</span><span><span class="badge vert">■</span> payé</span></div>
      <table class="cache"><caption>Dépenses des six derniers mois</caption><tbody>${c.evolution.map((e) => html`<tr><th>${e.mois}</th><td>${e.api_texte} au prix public</td><td>${e.reel_texte} payés</td></tr>`)}</tbody></table>
    </section>`
}

// Le budget se règle dans une fenêtre, depuis la page Utilisation.
function fenetreBudget() {
  const c = etat.reglages?.couts
  if (!c) return fenetre("Budget", html`<div class="chargement">Chargement…</div>`)
  return fenetre("Budget", html`<form class="pile" style="gap:14px" data-form="couts">
    <p class="aide" style="margin:0">Ce que l'usine peut dépenser en IA, au prix public. Elle te prévient en approchant de la limite (${c.alertes.join(", ")} %), puis te demande avant de continuer. Mets 0 pour ne pas fixer de limite.</p>
    <div class="grille">
      <div class="pile" style="gap:6px"><label class="titre-champ" for="b-mensuel">Par mois, pour toute l'usine (${c.devise})</label><input id="b-mensuel" name="budget_mensuel" class="champ" inputmode="decimal" value="${c.budget_mensuel}"></div>
      <div class="pile" style="gap:6px"><label class="titre-champ" for="b-projet">Par projet (${c.devise})</label><input id="b-projet" name="budget_par_projet" class="champ" inputmode="decimal" value="${c.budget_par_projet}"></div>
    </div>
    <details><summary class="aide" style="cursor:pointer">Ce que tu paies chaque mois (pour calculer le coût réel)</summary>
      <div class="grille" style="margin-top:10px">
        <div class="pile" style="gap:6px"><label class="aide" for="b-serveur">Le serveur (${c.devise})</label><input id="b-serveur" name="serveur_mensuel" class="champ" inputmode="decimal" value="${c.serveur_mensuel}"></div>
        ${c.abonnements.map((a, i) => html`<div class="pile" style="gap:6px"><label class="aide" for="b-ab-${i}">${a.nom} (${c.devise})</label><input id="b-ab-${i}" name="abonnement" class="champ" inputmode="decimal" value="${a.mensuel}"></div>`)}
      </div></details>
    <div class="rangee" style="justify-content:flex-end"><button type="button" class="btn btn-s" data-action="fermer-fenetre">Annuler</button><button type="submit" class="btn btn-p">Enregistrer</button></div>
  </form>`)
}

function vueEtatUsine() {
  const s = etat.sante
  if (!s) return html`<div class="chargement">Vérification de l'usine…</div>`
  const mj = s.serveur?.mise_a_jour
  const soucis = s.composants.filter((c) => c.etat !== "ok")
  const pannes = soucis.filter((c) => c.etat === "panne")
  return html`
    <div><h1>État de l'usine</h1><p class="chapeau">L'usine se vérifie elle-même chaque minute. La pastille en haut de chaque page résume ce bilan.</p></div>
    ${mj?.disponible ? html`<section class="carte carte-p barre" style="gap:12px;flex-wrap:wrap;border-color:var(--accent)"><span><strong>Une nouvelle version est disponible</strong><br><span class="aide">L'usine finit ce qu'elle fait, se met à jour et redémarre (quelques minutes).</span></span><button type="button" class="btn btn-p" data-action="usine" data-quoi="mettre-a-jour">Mettre à jour l'usine</button></section>` : ""}
    <section class="carte carte-p pile etat-general ${pannes.length ? "panne" : soucis.length ? "alerte" : "ok"}" aria-labelledby="etat-general">
      <h2 id="etat-general">${pannes.length ? (pannes.length === 1 ? "Un service est en panne" : `${pannes.length} services sont en panne`) : soucis.length ? (soucis.length === 1 ? "Un point demande ton attention" : `${soucis.length} points demandent ton attention`) : "Tout fonctionne"}</h2>
      ${soucis.length ? html`<ul class="soucis">${soucis.map((c) => html`<li><span class="point ${c.etat}" aria-hidden="true"></span><span><strong>${nomService(c.nom)}</strong> : ${c.detail}</span></li>`)}</ul>
        <div class="aide">Si une panne dure, préviens la personne qui s'occupe du serveur.</div>`
      : html`<div class="aide">${s.composants.length} services vérifiés.</div>`}
    </section>
    <section class="carte" aria-labelledby="services"><h2 id="services" style="padding:14px 16px 0">Tous les services</h2>
      <ul class="liste-services">${s.composants.map((c) => html`<li title="${c.nom}"><span class="point ${c.etat === "ok" ? "" : c.etat}" aria-hidden="true"></span><span style="flex:1;min-width:0"><strong>${nomService(c.nom)}</strong><br><span class="aide">${c.detail}</span></span><span class="cache">${c.etat === "ok" ? "fonctionne" : c.etat}</span></li>`)}</ul>
    </section>
    <section class="carte carte-p pile"><h2>Mettre l'usine en pause</h2>
      <div class="aide">L'usine termine ce qu'elle est en train de faire, puis s'arrête. Rien n'est perdu : elle reprend où elle en était.</div>
      <div class="rangee">${etat.resume?.usine.arretee ? html`<button type="button" class="btn btn-p" data-action="usine" data-quoi="reprendre">Reprendre</button>` : html`<button type="button" class="btn btn-s" data-action="usine" data-quoi="stop">Mettre en pause</button>`}</div></section>`
}

// Les cases « applications » d'une invitation ou d'une clé.
function casesApplis(nom, id) {
  const slugs = Object.entries(etat.acces?.noms ?? {})
  return html`<div class="pile" style="gap:6px" role="group" aria-labelledby="${id}">
    <label class="coche"><input type="checkbox" name="${nom}" value="*"><span>Toutes les applications</span></label>
    ${slugs.map(([slug, n]) => html`<label class="coche"><input type="checkbox" name="${nom}" value="${slug}"><span>${n ?? slug}</span></label>`)}</div>`
}

// L'invitation : plusieurs adresses en pastilles, un rôle décrit en une ligne (Sana).
function formulaireInviter() {
  const inv = etat.invites
  return html`<form class="pile" data-form="inviter" style="gap:14px">
    <div class="pile" style="gap:6px"><label class="titre-champ" for="inv-email">Adresses email</label>
      <div class="champ champ-pastilles">${inv.map((e, i) => html`<span class="etiquette">${e}<button type="button" class="btn-icone" data-action="retirer-invite" data-id="${i}" aria-label="Retirer ${e}">✕</button></span>`)}
        <input id="inv-email" name="saisie" type="email" multiple autocomplete="off" data-saisie-invites placeholder="${inv.length ? "Une autre adresse…" : "marie@exemple.fr"}"></div>
      <div class="aide">Plusieurs personnes à la fois : sépare les adresses par une virgule ou appuie sur Entrée.</div></div>
    <fieldset class="pile" style="gap:6px"><legend class="titre-champ">Ce qu'elles pourront faire</legend>
      <label class="choix"><input type="radio" name="role" value="membre" checked><span><strong>Membre</strong><br><span class="aide">Essaie les applications cochées ci-dessous.</span></span></label>
      <label class="choix"><input type="radio" name="role" value="admin"><span><strong>Administrateur</strong><br><span class="aide">Pilote l'usine avec toi : accès à tout, y compris cette console.</span></span></label></fieldset>
    <div class="pile" style="gap:6px"><div class="titre-champ" id="inv-applis">Les applications qu'un membre pourra ouvrir</div>${casesApplis("applis", "inv-applis")}</div>
    <div class="rangee" style="justify-content:flex-end">${etat.fenetre ? html`<button type="button" class="btn btn-s" data-action="fermer-fenetre">Annuler</button>` : ""}<button type="submit" class="btn btn-p">${inv.length > 1 ? `Inviter ${inv.length} personnes` : "Envoyer l'invitation"}</button></div>
  </form>`
}

function vueEquipe() {
  const a = etat.acces
  if (!a) return html`<div class="chargement">Chargement de l'équipe…</div>`
  const decrire = (u) => (u.role === "admin" ? "accès à tout" : u.applis.includes("*") ? "toutes les applications" : u.applis.map((s) => a.noms[s] ?? s).join(", ") || "aucune application")
  return html`
    <div class="entete"><div><h1>Équipe</h1><p class="chapeau">Chaque application est protégée par une page de connexion. On y entre sur invitation : la personne reçoit un lien et choisit son mot de passe.</p></div>
      <button type="button" class="btn btn-p" data-action="fenetre" data-quoi="inviter">Inviter</button></div>
    ${etat.invitation?.length ? html`<section class="carte carte-p pile" aria-label="Invitations envoyées" style="gap:8px">
      ${etat.invitation.map((x) => html`<div class="barre" style="gap:10px;flex-wrap:wrap"><span><strong>${x.email}</strong> · ${x.erreur ? x.erreur : x.envoye ? "invitation envoyée par email (lien valable 72 h)" : "l'email n'est pas parti : transmets ce lien toi-même (personnel, 72 h)"}</span>
        ${x.lien ? html`<button type="button" class="btn btn-s btn-petit" data-action="copier" data-texte="${x.lien}">Copier le lien</button>` : ""}</div>`)}
      <div><button type="button" class="lien-btn" style="padding-left:0" data-action="fermer-invitations">C'est noté</button></div>
    </section>` : ""}
    <section class="carte" aria-labelledby="personnes">
      <h2 id="personnes" class="cache">Les personnes</h2>
      <ul class="membres">${a.utilisateurs.map((u) => {
        const moi = u.email === etat.moi?.email
        return html`<li>
          <span class="avatar" aria-hidden="true">${initiales(u.nom || u.email)}</span>
          <span style="flex:1;min-width:200px"><strong>${u.nom || u.email}</strong>${moi ? html` <span class="aide">(toi)</span>` : ""}
            <span class="aide" style="display:block">${u.nom ? `${u.email} · ` : ""}${decrire(u)}</span></span>
          ${u.active ? "" : html`<span class="badge orange">invitation envoyée</span>`}
          <label class="cache" for="role-${u.id}">Rôle de ${u.email}</label>
          <select id="role-${u.id}" class="champ champ-petit" data-role-utilisateur="${u.id}" ${moi ? "disabled" : ""}>
            <option value="membre" ${u.role === "admin" ? "" : "selected"}>Membre</option>
            <option value="admin" ${u.role === "admin" ? "selected" : ""}>Administrateur</option>
          </select>
          <span class="rangee" style="gap:6px">${u.active ? "" : html`<button type="button" class="btn btn-s btn-petit" data-action="renvoyer" data-id="${u.id}">Renvoyer</button>`}
            ${moi ? "" : etat.confirmer === `retirer-${u.id}` ? html`<button type="button" class="btn btn-d btn-petit" data-action="retirer-personne" data-id="${u.id}">Oui, retirer</button><button type="button" class="btn btn-s btn-petit" data-action="annuler">Annuler</button>` : html`<button type="button" class="btn btn-s btn-petit" data-action="confirmer" data-quoi="retirer-${u.id}">Retirer</button>`}</span>
        </li>`
      })}</ul>
    </section>
    <details class="carte carte-p" ${etat.cleCreee || a.cles.length ? "open" : ""}>
      <summary style="cursor:pointer;font-weight:600">Pour les développeurs : clés d'accès pour d'autres logiciels</summary>
      <div class="pile" style="margin-top:12px;gap:14px">
        <div class="aide">Quand un autre logiciel doit appeler une de tes applications (une intégration, un script), il présente une clé au lieu d'un mot de passe : en-tête <span class="mono">Authorization: Bearer &lt;clé&gt;</span>. L'usine ne garde que son empreinte.</div>
        ${etat.cleCreee ? html`<div class="cle-unique" role="status"><strong>Copie la clé maintenant : elle ne sera plus jamais affichée.</strong>
          <div class="rangee" style="flex-wrap:nowrap"><code class="mono" id="cle-texte">${etat.cleCreee}</code><button type="button" class="btn" style="background:var(--fond);color:var(--encre)" data-action="copier-cle">Copier</button><button type="button" class="btn" style="background:var(--fond);color:var(--encre)" data-action="fermer-cle">C'est fait</button></div></div>` : ""}
        ${a.cles.length ? html`<div class="tableau"><table style="min-width:600px"><thead><tr><th>Nom</th><th>Applications</th><th>Dernier usage</th><th><span class="cache">Actions</span></th></tr></thead>
          <tbody>${a.cles.map((c) => html`<tr><td><strong>${c.nom}</strong><div class="sous mono">${c.debut}… · créée le ${heure(c.cree_le)}${c.cree_par ? ` par ${c.cree_par}` : ""}</div></td><td>${c.applis.includes("*") ? "toutes" : c.applis.map((s) => a.noms[s] ?? s).join(", ")}</td><td>${c.utilisee_le ? heure(c.utilisee_le) : html`<span class="aide">jamais</span>`}</td>
            <td style="text-align:right"><button type="button" class="btn btn-d btn-petit" data-action="revoquer" data-id="${c.id}">Désactiver</button></td></tr>`)}</tbody></table></div>` : ""}
        <form class="pile" style="gap:12px" data-form="cle">
          <strong>Créer une clé</strong>
          <div class="grille">
            <div class="pile" style="gap:6px"><label class="aide" for="cle-nom">À quoi elle sert</label><input id="cle-nom" name="nom" class="champ" required maxlength="60" placeholder="Ex. : intégration avec le CRM"></div>
            <div class="pile" style="gap:6px"><div class="aide" id="cle-applis">Les applications qu'elle ouvre</div>${casesApplis("applis", "cle-applis")}</div>
          </div>
          <div><button type="submit" class="btn btn-s">Créer la clé</button></div>
        </form>
      </div>
    </details>`
}

const ROLES = { analyste: "Qui fait le plan", atelier: "Qui construit", verificateur: "Qui contrôle", petites_taches: "Petites tâches", produit: "L'IA dans les applications", renfort: "Renfort quand ça bloque" }
const POLITIQUES = { jamais: "jamais", manuel: "toi seulement", "sur-criteres": "l'usine, si les contrôles passent" }
const ACTIONS_POLITIQUES = { implementer: "Construire une fonction", merger: "Ajouter une fonction au produit", deployer_apercu: "Mettre un aperçu en ligne", mettre_en_production: "Mettre en ligne pour de vrai", supprimer_des_donnees: "Supprimer des données" }

// --- L'intelligence artificielle ---------------------------------------------------------------
const NOMS_MOTEURS = { "claude-code": ["Claude", "construit les applications, fait le plan, relit le code"], codex: ["ChatGPT", "contrôle chaque fonction, comme un visiteur"] }
const NOMS_MODES = {
  "claude-code": { abonnement: "Abonnement Claude (Pro ou Max)", cle: "Clé payée à l'usage (Anthropic)", passerelle: "Passerelle Vercel (secours)" },
  codex: { abonnement: "Abonnement ChatGPT", cle: "Clé payée à l'usage (OpenAI)", passerelle: "Passerelle Vercel (secours)" },
}
const ROLES_MODELES = { analyste: "Qui fait le plan", atelier: "Qui construit", renfort: "Renfort quand ça bloque", relecteur: "Qui relit", petites_taches: "Petites tâches" }
const MODELES_CONNUS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"]
const dateCourte = (le) => (le ? new Date(le).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "")

function badgeTest(t) {
  if (!t) return html`<span class="badge">pas encore testé</span>`
  if (t.etat === "ok") return html`<span class="badge vert">fonctionne</span>`
  if (t.etat === "absent") return html`<span class="badge">pas configuré</span>`
  return html`<span class="badge rouge" title="${t.detail ?? ""}">ne répond pas</span>`
}

// Une valeur secrète : d'où elle vient (console ou serveur), jamais la valeur elle-même.
function champIdentifiant(f, nom, aide, titre = null) {
  const i = f.identifiants.find((x) => x.nom === nom)
  const source = i.console ? html`<span class="badge vert">enregistrée · …${i.console.fin}</span> <span class="aide">le ${dateCourte(i.console.le)} par ${i.console.par}</span>`
    : i.serveur ? html`<span class="badge">posée sur le serveur</span>` : html`<span class="badge orange">manquante</span>`
  return html`<form class="pile" style="gap:6px" data-form="identifiant" data-nom="${nom}">
    <div class="barre" style="flex-wrap:wrap;gap:6px"><label for="id-${nom}"><strong style="font-size:14px">${titre ?? i.libelle}</strong></label><span>${source}</span></div>
    <div class="rangee" style="flex-wrap:nowrap"><input id="id-${nom}" name="valeur" type="password" class="champ mono" autocomplete="off" spellcheck="false" placeholder="${i.console || i.serveur ? "Coller une nouvelle valeur pour la remplacer" : "Coller ici"}" required>
    <button type="submit" class="btn btn-s">Enregistrer</button>
    ${i.console ? html`<button type="button" class="btn btn-s" data-action="retirer-identifiant" data-nom="${nom}">Retirer</button>` : ""}</div>
    ${aide ? html`<div class="aide">${aide}</div>` : ""}
  </form>`
}

// Une IA : son état d'abord, puis comment la brancher. L'ordre de secours est un réglage avancé.
function carteMoteur(f, m) {
  const tests = f.tests.resultats?.[m.id] ?? {}
  const tous = [...m.modes, ...["abonnement", "cle", "passerelle"].filter((x) => !m.modes.includes(x))]
  const marche = Object.values(tests).some((t) => t?.etat === "ok")
  const chat = etat.chatgpt
  const [nom, role] = NOMS_MOTEURS[m.id] ?? [m.libelle, ""]
  return html`<div class="carte carte-p pile" style="gap:14px">
    <div class="barre"><div><strong style="font-size:16px">${nom}</strong><div class="aide">${role}</div></div>${f.tests.le ? (marche ? html`<span class="badge vert">branché</span>` : html`<span class="badge rouge">ne répond pas</span>`) : html`<span class="badge">pas encore testé</span>`}</div>
    ${m.id === "claude-code" ? html`
      ${champIdentifiant(f, "CLAUDE_CODE_OAUTH_TOKEN", brut(`Le plus simple si tu as un abonnement Claude Pro ou Max. Un technicien lance <span class="mono">claude setup-token</span> sur son ordinateur et te donne le code obtenu (il commence par <span class="mono">sk-ant-oat</span>, valable un an).`), "Avec ton abonnement Claude")}
      <details><summary class="aide" style="cursor:pointer">Ou avec une clé payée à l'usage</summary><div style="margin-top:10px">${champIdentifiant(f, "ANTHROPIC_API_KEY", brut(`Sur <span class="mono">console.anthropic.com</span>, rubrique « API Keys ». Tu paies ce que l'usine consomme.`), "Clé Anthropic")}</div></details>` : html`
      <div class="pile" style="gap:6px">
        <div class="barre" style="flex-wrap:wrap;gap:6px"><strong style="font-size:14px">Avec ton abonnement ChatGPT</strong>${badgeTest(tests.abonnement)}</div>
        ${chat?.etat === "code" ? html`<div class="carte carte-p pile" style="gap:6px;border-color:var(--accent)"><div>1. Ouvre <a href="${chat.url}" target="_blank" rel="noopener noreferrer">${chat.url}</a> et connecte-toi à ton compte ChatGPT.</div><div>2. Saisis ce code :</div><div class="mono" style="font-size:22px;letter-spacing:2px"><strong>${chat.code}</strong></div><div class="aide">Valable 15 minutes. Cette page se met à jour toute seule quand c'est fait.</div></div>`
          : chat?.etat === "attente" ? html`<div class="aide">Préparation du lien de connexion…</div>`
          : html`<div><button type="button" class="btn btn-s" data-action="connecter-chatgpt">${tests.abonnement?.etat === "ok" ? "Reconnecter un compte ChatGPT" : "Connecter mon compte ChatGPT"}</button></div><div class="aide">Un lien et un code à saisir sur le site d'OpenAI : rien à copier.</div>`}
      </div>
      <details><summary class="aide" style="cursor:pointer">Ou avec une clé payée à l'usage</summary><div style="margin-top:10px">${champIdentifiant(f, "OPENAI_API_KEY", brut(`Sur <span class="mono">platform.openai.com</span>, rubrique « API keys ». Tu paies ce que l'usine consomme.`), "Clé OpenAI")}</div></details>`}
    <details><summary class="aide" style="cursor:pointer">Réglage avancé : l'ordre de secours</summary>
      <div class="pile" style="margin-top:10px;gap:8px">
        <div class="aide">Quand une façon de se connecter atteint sa limite ou n'a plus de crédit, l'usine passe à la suivante, sans perdre le travail en cours.</div>
        <div class="tableau"><table><tbody>${tous.map((mode) => {
          const actif = m.modes.includes(mode)
          const rang = m.modes.indexOf(mode)
          return html`<tr>
            <td style="width:2.5em">${actif ? html`<strong>${rang + 1}</strong>` : html`<span class="aide">—</span>`}</td>
            <td>${actif ? NOMS_MODES[m.id][mode] : html`<span class="aide">${NOMS_MODES[m.id][mode]} (désactivée)</span>`}</td>
            <td>${badgeTest(tests[mode])}</td>
            <td style="text-align:right;white-space:nowrap">
              ${actif && rang > 0 ? petitBouton("mode-monter", `data-moteur="${m.id}" data-mode="${mode}"`, "↑", `Passer ${NOMS_MODES[m.id][mode]} avant`) : ""}
              <button type="button" class="btn btn-s btn-petit" data-action="mode-basculer" data-moteur="${m.id}" data-mode="${mode}">${actif ? "Désactiver" : "Activer"}</button>
            </td></tr>`
        })}</tbody></table></div>
      </div></details>
  </div>`
}

// GitHub : l'application de l'usine (des accès qui expirent), ou le jeton du serveur.
function carteGithub(f) {
  const app = f.app ?? { mode: "jeton" }
  const formulaire = html`<form class="pile" style="gap:10px" data-form="github">
    <fieldset class="pile" style="gap:6px;border:0;padding:0;margin:0"><legend class="aide">Où ranger le code des applications ?</legend>
      <label class="choix"><input type="radio" name="cible" value="perso" checked><span>Sur mon compte GitHub</span></label>
      <label class="choix"><input type="radio" name="cible" value="org"><span>Dans une organisation GitHub (celle de l'entreprise) :</span></label>
      <input name="organisation" class="champ mono" placeholder="nom-de-l-organisation" autocomplete="off" spellcheck="false" aria-label="Nom de l'organisation GitHub">
    </fieldset>
    <div><button type="submit" class="btn btn-p">Se connecter avec GitHub</button></div>
    <div class="aide">GitHub te demande deux clics : créer l'application de l'usine, puis l'autoriser sur « tous les dépôts » (All repositories). Rien à copier.</div>
  </form>`
  return html`<div class="pile" style="gap:10px">
    <div class="barre"><strong>GitHub</strong>${app.mode === "application" ? html`<span class="badge vert">branché</span>` : app.mode === "a_installer" ? html`<span class="badge orange">dernière étape à faire</span>` : f.compte?.ok ? html`<span class="badge vert">branché</span>` : html`<span class="badge orange">pas branché</span>`}</div>
    ${app.mode === "application" ? html`
      <div style="font-size:14px">Le code est rangé sur <span class="mono">${app.compte}</span> (${app.type === "Organization" ? "organisation" : "compte personnel"}), en ${f.visibilite === "public" ? "public" : "privé"}.</div>
      ${app.tous_depots === false ? html`<div class="message erreur">L'usine n'a accès qu'à une partie du compte : elle ne pourra pas ranger le code des nouvelles applications. Sur GitHub, choisis « All repositories ».</div>` : ""}
      <div class="aide">Branché le ${dateCourte(app.le)} par ${app.par}.</div>
      <div class="rangee"><a class="btn btn-s" href="${app.gerer}" target="_blank" rel="noopener noreferrer">Gérer sur GitHub</a><button type="button" class="btn btn-s" data-action="github-oublier">Débrancher</button></div>`
    : app.mode === "a_installer" ? html`
      <div style="font-size:14px">Il reste à autoriser l'usine sur ton compte ou ton organisation.</div>
      <div class="rangee"><a class="btn btn-p" href="${app.installer}">Autoriser l'usine sur GitHub</a><button type="button" class="btn btn-s" data-action="github-oublier">Recommencer</button></div>`
    : html`
      ${f.compte?.ok ? html`<div style="font-size:14px">Le code est rangé sur <span class="mono">${f.proprietaire}</span>.</div><div class="aide">Branché avec une clé posée sur le serveur. Plus sûr : se connecter ci-dessous (l'usine n'obtient alors que des accès qui expirent au bout d'une heure).</div>` : ""}
      ${formulaire}`}
  </div>`
}

// Google Drive : un compte de service, avec qui on partage ses dossiers comme avec un collègue.
function fenetreDrive() {
  const g = etat.drive
  if (!g) return fenetre("Google Drive", html`<div class="chargement">Chargement…</div>`)
  if (g.configure) return fenetre("Google Drive", html`<div class="pile" style="gap:16px">
    <div class="barre"><strong>Branché</strong><span class="badge vert">lecture seule</span></div>
    <div class="pile" style="gap:6px"><span>Partage tes dossiers (ou des fichiers) avec cette adresse, comme avec un collègue, en <strong>lecteur</strong> :</span>
      <code class="mono jeton">${g.email}</code>
      <div><button type="button" class="btn btn-s btn-petit" data-action="copier" data-quoi="drive-email">Copier l'adresse</button></div></div>
    <p class="aide" style="margin:0">L'usine ne voit que ce qui est partagé avec cette adresse. Pour créer un public : Publics, « Nouveau public », « Depuis Google Drive », puis colle le lien du dossier.</p>
    <div class="rangee" style="justify-content:space-between;gap:8px"><button type="button" class="btn btn-d btn-petit" data-action="retirer-drive">Débrancher</button><button type="button" class="btn btn-s" data-action="tester-drive">Tester</button></div>
  </div>`)
  return fenetre("Brancher Google Drive", html`<div class="pile" style="gap:16px">
    <p style="margin:0">L'usine lit les documents des dossiers que tu lui partages : études, comptes rendus d'entretiens, tableaux. Il faut une fois un « compte de service » Google, une adresse réservée à l'usine.</p>
    <ol class="etapes-machine">
      <li>Sur <span class="mono">console.cloud.google.com</span>, choisis (ou crée) un projet, puis active l'<strong>API Google Drive</strong> (API et services, Bibliothèque).</li>
      <li>IAM et administration, <strong>Comptes de service</strong>, Créer un compte de service. Aucun rôle n'est nécessaire.</li>
      <li>Dans ce compte : Clés, Ajouter une clé, Créer une clé, format <strong>JSON</strong>. Un fichier se télécharge.</li>
      <li>Ouvre ce fichier avec un éditeur de texte et colle tout son contenu ici. Il est chiffré et ne s'affichera plus.</li>
    </ol>
    <form class="pile" data-form="drive-compte" style="gap:10px">
      <label class="titre-champ" for="drive-cle">Contenu du fichier de clé (.json)</label>
      <textarea id="drive-cle" name="cle" class="champ mono" rows="5" required autocomplete="off" spellcheck="false" placeholder='{ "type": "service_account", "project_id": "…", "private_key": "-----BEGIN PRIVATE KEY-----…", "client_email": "…@….iam.gserviceaccount.com", … }'></textarea>
      <div class="rangee" style="justify-content:flex-end;gap:8px"><button type="button" class="btn btn-s" data-action="fermer-fenetre">Annuler</button><button type="submit" class="btn btn-p">Brancher</button></div>
    </form>
  </div>`)
}

// Les intégrations en cartes : un logo, une phrase, « Connecter » ou « Connecté » (Unify, MagicPath).
function integrations() {
  const f = etat.fournisseurs
  const r = etat.reglages
  const moteur = (id) => (!f?.tests.le ? null : Object.values(f.tests.resultats?.[id] ?? {}).some((t) => t?.etat === "ok"))
  const app = r?.forge.app ?? { mode: "jeton" }
  return [
    { id: "claude", nom: "Claude", logo: "C", couleur: "#c4603f", texte: "Construit les applications, fait le plan, relit le code.", branche: moteur("claude-code") },
    { id: "chatgpt", nom: "ChatGPT", logo: "G", couleur: "#0f7a5f", texte: "Contrôle chaque fonction, comme le ferait un visiteur.", branche: moteur("codex") },
    { id: "github", nom: "GitHub", logo: "GH", couleur: "#24292f", texte: "Range le code de chaque application et l'historique de ce qui a été fait.", branche: app.mode === "application" || r?.forge.compte?.ok ? true : app.mode === "a_installer" ? "presque" : false },
    { id: "slack", nom: "Slack", logo: "S", couleur: "#4a154b", texte: "Facultatif : des notifications et des boutons dans un canal de ton équipe.", branche: Boolean(r?.slack?.branche), facultatif: true },
    { id: "drive", nom: "Google Drive", logo: "▲", couleur: "#1a73e8", texte: "Facultatif : lit les dossiers que tu partages avec l'usine, pour créer un public à partir de tes documents.", branche: Boolean(etat.drive?.configure), facultatif: true },
  ]
}
const badgeIntegration = (x) => (x.branche === true ? html`<span class="badge vert">Connecté</span>`
  : x.branche === null ? html`<span class="badge">pas encore testé</span>`
  : x.branche === "presque" ? html`<span class="badge orange">dernière étape</span>`
  : x.facultatif ? html`<span class="badge">facultatif</span>` : html`<span class="badge orange">à connecter</span>`)

function vueIntegrations() {
  const f = etat.fournisseurs
  if (!f || !etat.reglages) return html`<div class="chargement">Chargement…</div>`
  return html`
    <div class="entete"><div><h1>Intégrations</h1><p class="chapeau">Les services avec lesquels l'usine travaille. Ce que tu y colles est chiffré et ne s'affiche plus jamais.</p>
      ${f.protection === "axmaril" ? html`<p style="margin:8px 0 0"><span class="badge vert">clés scellées</span> <span class="aide">Même une copie du serveur ne permettrait pas de les lire.</span></p>` : ""}</div>
      <div class="pile" style="gap:4px;align-items:flex-end"><button type="button" class="btn btn-s" data-action="tester-fournisseurs">Tester les connexions</button><span class="aide">${f.tests.le ? `Dernier test : ${dateCourte(f.tests.le)}` : "Jamais testé"}</span></div></div>
    ${f.verrouille ? html`<div class="message erreur">Les clés enregistrées ici sont verrouillées pour l'instant : l'usine utilise celles du serveur. Préviens la personne qui s'occupe du serveur.</div>` : ""}
    <div class="cartes-integrations">${integrations().map((x) => html`<div class="carte carte-integration">
      <div class="barre"><span class="logo-integration" style="background:${x.couleur}" aria-hidden="true">${x.logo}</span>${badgeIntegration(x)}</div>
      <strong>${x.nom}</strong><span class="aide" style="flex:1">${x.texte}</span>
      <div><button type="button" class="btn ${x.branche === true || x.facultatif ? "btn-s" : "btn-p"} btn-petit" data-action="fenetre" data-quoi="integration-${x.id}" aria-label="${x.branche === true ? "Gérer" : "Connecter"} ${x.nom}">${x.branche === true ? "Gérer" : x.facultatif ? "Voir" : "Connecter"}</button></div>
    </div>`)}</div>
    <details class="carte carte-p"><summary style="cursor:pointer;font-weight:600">Réglages avancés : passerelle de secours et modèles</summary>
      <div class="pile" style="gap:16px;margin-top:12px">
        <div class="pile" style="gap:10px">
          <div class="aide">La passerelle Vercel AI Gateway donne accès aux deux IA avec une seule clé : elle sert de secours commun. Sur <span class="mono">vercel.com</span>, AI Gateway, API Keys.</div>
          ${champIdentifiant(f, "AI_GATEWAY_API_KEY", "", "Clé de la passerelle Vercel")}
        </div>
        <form class="pile" style="gap:12px" data-form="modeles">
          <div><strong>Quel modèle pour quel rôle</strong><div class="aide">Laisse vide pour garder le choix par défaut.</div></div>
          <datalist id="modeles-connus">${MODELES_CONNUS.map((x) => html`<option value="${x}"></option>`)}</datalist>
          <div class="grille">${f.modeles.map((m) => html`<div class="pile" style="gap:6px"><label class="aide" for="mod-${m.role}">${ROLES_MODELES[m.role] ?? m.role}</label><input id="mod-${m.role}" name="${m.role}" class="champ mono" list="modeles-connus" value="${m.modele !== m.contrat ? m.modele : ""}" placeholder="${m.contrat ?? m.modele}" autocomplete="off" spellcheck="false"></div>`)}</div>
          <div><button type="submit" class="btn btn-s">Enregistrer les modèles</button></div>
        </form>
      </div>
    </details>`
}

// Chaque intégration s'ouvre dans sa propre fenêtre (Gumloop).
function fenetreIntegration(id) {
  const f = etat.fournisseurs
  const r = etat.reglages
  if (!f || !r) return fenetre("Intégration", html`<div class="chargement">Chargement…</div>`)
  if (id === "claude" || id === "chatgpt") {
    const m = f.moteurs.find((x) => x.id === (id === "claude" ? "claude-code" : "codex"))
    return fenetre(id === "claude" ? "Claude" : "ChatGPT", m ? html`${carteMoteur(f, m)}<div class="rangee" style="justify-content:flex-end"><button type="button" class="btn btn-s" data-action="tester-fournisseurs">Tester la connexion</button></div>` : html`<div class="aide">Cette IA n'est pas prévue dans la configuration de l'usine.</div>`)
  }
  if (id === "drive") return fenetreDrive()
  if (id === "github") return fenetre("GitHub", html`<p class="aide" style="margin:0">Chaque application a son espace sur GitHub, où l'usine range son code et l'historique de ce qu'elle a fait. Tu peux y jeter un œil, mais tu n'en as pas besoin au quotidien.</p>${carteGithub(r.forge)}`)
  return fenetre("Slack", html`<div class="pile" style="gap:10px">
    <div class="barre"><strong>${r.slack?.branche ? "Connecté" : "Pas connecté"}</strong>${r.slack?.branche && r.slack.canal ? html`<span class="aide">canal ${r.slack.canal}</span>` : ""}</div>
    <p style="margin:0">Tout se fait dans cette console. Slack ajoute seulement des notifications et des boutons dans un canal de ton équipe.</p>
    <p class="aide" style="margin:0">Pour le brancher, demande à la personne qui s'occupe du serveur.</p>
    <div class="rangee" style="justify-content:flex-end"><button type="button" class="btn btn-s" data-action="fermer-fenetre">Fermer</button></div></div>`)
}

function vueRegles() {
  const k = etat.reglages?.contrat
  if (!k) return html`<div class="chargement">Chargement…</div>`
  return html`
    <div><h1>Règles de l'usine</h1><p class="chapeau">Ces règles sont appliquées par l'usine elle-même. Elles se changent sur le serveur, par un technicien.</p></div>
    <section class="carte carte-p pile" aria-labelledby="qui-decide"><h2 id="qui-decide">Qui décide</h2>
      ${Object.entries(k.politiques).map(([a, v]) => html`<div class="barre" style="font-size:14px;padding:6px 0;border-bottom:1px solid var(--trait-2)"><span>${ACTIONS_POLITIQUES[a] ?? a}</span><span class="badge ${v === "manuel" ? "orange" : v === "jamais" ? "rouge" : "vert"}">${POLITIQUES[v] ?? v}</span></div>`)}</section>
    <section class="carte carte-p grille" style="font-size:14px" aria-label="Limites">
      <div><div class="aide">Quand une fonction est refusée</div>l'usine la refait <strong>${k.autonomie.tentatives_par_tache ?? 2} fois</strong>, puis essaie <strong>${k.autonomie.changements_d_approche ?? 1} autre méthode</strong> avant de te demander</div>
      <div><div class="aide">Temps maximum pour une fonction</div><strong>${k.autonomie.minutes_max_par_agent ?? 30} minutes</strong></div>
      <div><div class="aide">Aperçus</div>retirés après <strong>${k.apercus_jours} jours</strong> sans activité (tu es prévenu la veille)</div>
      <div><div class="aide">Mode démonstration</div><strong>${k.demo ? "actif" : "inactif"}</strong> : données fictives, emails retenus${k.finition ? ", lot de finition" : ""}</div>
    </section>
    <details class="carte carte-p"><summary style="cursor:pointer;font-weight:600">Pour les techniciens</summary>
      <div class="pile" style="gap:8px;margin-top:8px">
        <div class="tableau"><table><tbody>${k.modeles.map((m) => html`<tr><td>${ROLES[m.role] ?? m.role}</td><td class="mono">${m.modele}</td><td class="aide">${m.moteur}</td></tr>`)}</tbody></table></div>
        <div class="aide">Fichier : <span class="mono">usine.config.yml</span> · fichiers protégés des produits : <span class="mono">${k.perimetre_protege.join(" · ")}</span></div>
      </div></details>`
}

// Les réglages : un sous-menu à gauche, la section à droite.
function vueReglages() {
  const s = etat.route.section ?? "integrations"
  const contenu = { integrations: vueIntegrations, connecteurs: vueConnecteurs, equipe: vueEquipe, utilisation: vueUtilisation, etat: vueEtatUsine, historique: vueHistorique, regles: vueRegles }[s]
  return html`
    ${barreHaut()}
    <div class="reglages">
      <nav class="sous-menu" aria-label="Réglages">
        ${SECTIONS_REGLAGES.map(([id, nom, aide]) => html`<a href="#/reglages/${id}" ${brut(id === s ? 'aria-current="page"' : "")}><strong>${nom}</strong><small>${aide}</small></a>`)}
        <a href="#/demarrer"><strong>Premiers pas</strong><small>Rouvrir l'assistant</small></a>
      </nav>
      <div class="reglages-contenu">${messageGlobal()}${contenu()}</div>
    </div>`
}

// Les connecteurs : des outils que les IA de l'usine utilisent pendant leur travail (Emergent, Claude).
// L'API attendue : GET connecteurs, PUT connecteurs/:id { actif, roles }, PUT et DELETE connecteurs/:id/cle,
// POST connecteurs/:id/tester, POST connecteurs { nom, adresse, cle }, DELETE connecteurs/:id (un connecteur ajouté).
const ROLES_CONNECTEURS = [
  ["plan", "Plan", "l'IA qui comprend la demande et prépare le plan"],
  ["construction", "Construction", "l'IA qui écrit le code"],
  ["verification", "Vérification", "l'IA qui essaie chaque fonction"],
]
const FAMILLES_CONNECTEURS = [["", "Tous"], ["actifs", "Actifs"], ["comprendre", "Comprendre"], ["construire", "Construire"], ["verifier", "Vérifier"]]
const nomRoleConnecteur = (r) => (ROLES_CONNECTEURS.find(([id]) => id === r) ?? [r, r])[1]

function badgeConnecteur(c) {
  if (c.etat === "erreur") return html`<span class="badge rouge">ne répond pas</span>`
  if (c.actif) return html`<span class="badge vert">actif</span>`
  if (c.cle && !c.cle_remplie) return html`<span class="badge orange">clé à coller</span>`
  return html`<span class="badge">inactif</span>`
}

function vueConnecteurs() {
  const k = etat.connecteurs
  if (!k) return html`<div class="chargement">Chargement…</div>`
  const entete = html`<div class="entete"><div><h1>Connecteurs</h1><p class="chapeau">Des outils que les IA de l'usine utilisent pendant leur travail : lire une documentation à jour, ouvrir l'application dans un navigateur, consulter tes maquettes. Plus elles ont de contexte, moins elles se trompent.</p></div>
    ${k.indisponible ? "" : html`<button type="button" class="btn btn-s" data-action="fenetre" data-quoi="connecteur-ajouter">+ Ajouter un connecteur</button>`}</div>`
  if (k.indisponible) return html`${entete}<div class="carte vide">Cette version de l'usine ne gère pas encore les connecteurs. Ils arriveront avec une prochaine mise à jour.</div>`
  const f = etat.filtreConnecteurs
  const liste = k.connecteurs.filter((c) => !f || (f === "actifs" ? c.actif : c.famille === f))
  const actifs = k.connecteurs.filter((c) => c.actif)
  const conseil = k.connecteurs.find((c) => c.conseille && !c.actif)
  return html`
    ${entete}
    <div class="carte carte-p resume-connecteurs">
      <div><strong>${actifs.length ? `${actifs.length} connecteur${actifs.length > 1 ? "s" : ""} actif${actifs.length > 1 ? "s" : ""}` : "Aucun connecteur actif"}</strong>
        <span class="aide">${actifs.length ? " · les IA s'en servent dès leur prochaine tâche" : " · les IA travaillent avec ce qu'elles savent déjà"}</span></div>
      ${conseil ? html`<div class="conseil-connecteur"><span><span class="badge bleu">conseillé</span> <strong>${conseil.nom}</strong> <span class="aide">· ${conseil.apport}</span></span>
        <button type="button" class="btn btn-p btn-petit" data-action="fenetre" data-quoi="connecteur-${conseil.id}">Activer</button></div>` : ""}
    </div>
    <div class="rangee" role="group" aria-label="Filtrer les connecteurs" style="gap:6px">${FAMILLES_CONNECTEURS.map(([id, nom]) => html`<button type="button" class="filtre" data-action="filtre-connecteurs" data-id="${id}" aria-pressed="${String(f === id)}">${nom}</button>`)}</div>
    ${liste.length ? html`<div class="cartes-integrations">${liste.map((c) => html`<div class="carte carte-integration">
      <div class="barre"><span class="logo-integration" style="background:${c.couleur ?? "#5b6b7a"}" aria-hidden="true">${c.logo ?? c.nom.slice(0, 1)}</span>${badgeConnecteur(c)}</div>
      <strong>${c.nom}</strong><span class="aide" style="flex:1">${c.apport}</span>
      ${c.actif ? html`<div class="roles-connecteur" aria-label="Utilisé par">${c.roles.map((r) => html`<span class="etiquette">${nomRoleConnecteur(r)}</span>`)}</div>` : ""}
      <div><button type="button" class="btn ${c.actif ? "btn-s" : "btn-p"} btn-petit" data-action="fenetre" data-quoi="connecteur-${c.id}" aria-label="${c.actif ? "Gérer" : "Activer"} ${c.nom}">${c.actif ? "Gérer" : "Activer"}</button></div>
    </div>`)}</div>` : html`<div class="carte vide">Aucun connecteur dans cette famille.</div>`}`
}

// La clé d'un connecteur : d'où elle vient, jamais la valeur elle-même.
function formulaireCleConnecteur(c) {
  return html`<form class="pile" style="gap:6px" data-form="cle-connecteur" data-id="${c.id}">
    <div class="barre" style="flex-wrap:wrap;gap:6px"><label for="cle-${c.id}"><strong style="font-size:14px">${c.cle.libelle}</strong></label>
      ${c.cle_remplie ? html`<span class="badge vert">enregistrée${c.cle_fin ? ` · …${c.cle_fin}` : ""}</span>` : html`<span class="badge orange">à coller</span>`}</div>
    <div class="rangee" style="flex-wrap:nowrap"><input id="cle-${c.id}" name="valeur" type="password" class="champ mono" autocomplete="off" spellcheck="false" placeholder="${c.cle_remplie ? "Coller une nouvelle clé pour la remplacer" : "Coller ici"}" required>
      <button type="submit" class="btn btn-s">Enregistrer</button>
      ${c.cle_remplie ? html`<button type="button" class="btn btn-s" data-action="retirer-cle-connecteur" data-id="${c.id}">Retirer</button>` : ""}</div>
    ${c.cle.aide ? html`<div class="aide">${c.cle.aide}</div>` : ""}
  </form>`
}

function fenetreConnecteur(id) {
  const c = etat.connecteurs?.connecteurs?.find((x) => String(x.id) === id)
  if (!c) return fenetre("Connecteur", html`<div class="chargement">Chargement…</div>`)
  const bloque = Boolean(c.cle && !c.cle_remplie)
  return fenetre(c.nom, html`<div class="pile" style="gap:18px">
    <div class="rangee" style="flex-wrap:nowrap;gap:12px;align-items:flex-start"><span class="logo-integration" style="background:${c.couleur ?? "#5b6b7a"}" aria-hidden="true">${c.logo ?? c.nom.slice(0, 1)}</span>
      <div class="pile" style="gap:4px"><p style="margin:0">${c.texte ?? c.apport}</p>${c.perso ? html`<span class="aide mono">${c.adresse}</span>` : ""}</div></div>
    ${c.peut?.length || c.limites?.length ? html`<div class="grille">
      ${c.peut?.length ? html`<div><strong>Ce que les IA peuvent faire</strong><ul class="puces" style="margin-top:6px">${c.peut.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}
      ${c.limites?.length ? html`<div><strong>Ce qu'elles ne peuvent pas faire</strong><ul class="puces" style="margin-top:6px">${c.limites.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}
    </div>` : ""}
    ${c.cle ? formulaireCleConnecteur(c) : ""}
    <form class="pile" data-form="connecteur" data-id="${c.id}" style="gap:12px">
      <fieldset class="pile" style="gap:8px;border:0;padding:0;margin:0"><legend style="padding:0;margin-bottom:8px"><strong>Quelles IA peuvent s'en servir</strong></legend>
        ${ROLES_CONNECTEURS.map(([r, nom, aide]) => html`<label class="case"><input type="checkbox" name="roles" value="${r}" ${(c.actif ? c.roles : c.roles_conseilles ?? c.roles).includes(r) ? "checked" : ""}><span><strong>${nom}</strong> <span class="aide">· ${aide}</span></span></label>`)}
      </fieldset>
      ${bloque ? html`<div class="aide">Colle d'abord la clé ci-dessus pour pouvoir l'activer.</div>` : ""}
      <div class="barre" style="flex-wrap:wrap;gap:10px">
        <span class="aide">${c.test ? `Dernier test le ${dateCourte(c.test.le)} : ${c.test.ok ? "il répond" : "pas de réponse"}` : c.actif ? "Pas encore testé" : ""}</span>
        <div class="rangee" style="gap:8px">
          ${c.actif ? html`<button type="button" class="btn btn-s" data-action="tester-connecteur" data-id="${c.id}">Tester</button><button type="submit" name="actif" value="non" class="btn btn-s">Désactiver</button>` : ""}
          <button type="submit" name="actif" value="oui" class="btn btn-p" ${bloque ? "disabled" : ""}>${c.actif ? "Enregistrer" : "Activer"}</button>
        </div>
      </div>
    </form>
    ${c.perso ? html`<div class="separe barre"><span class="aide">Ajouté par ${c.par ?? "un administrateur"}</span><button type="button" class="btn btn-s btn-petit" data-action="retirer-connecteur" data-id="${c.id}">Retirer ce connecteur</button></div>` : ""}
  </div>`)
}

const fenetreAjoutConnecteur = () => fenetre("Ajouter un connecteur", html`<form class="pile" data-form="connecteur-ajouter" style="gap:14px">
  <p class="aide" style="margin:0">Pour un outil qui n'est pas dans la liste. La personne qui s'en occupe te donne son adresse : c'est un serveur MCP, le format que comprennent les IA.</p>
  <div class="pile" style="gap:6px"><label for="cx-nom"><strong>Nom</strong></label><input id="cx-nom" name="nom" class="champ" required maxlength="60" placeholder="Base clients interne"></div>
  <div class="pile" style="gap:6px"><label for="cx-adresse"><strong>Adresse</strong></label><input id="cx-adresse" name="adresse" type="url" class="champ mono" required placeholder="https://outil.mon-entreprise.fr/mcp" spellcheck="false"></div>
  <div class="pile" style="gap:6px"><label for="cx-cle"><strong>Clé</strong> <span class="aide">facultative</span></label><input id="cx-cle" name="cle" type="password" class="champ mono" autocomplete="off" spellcheck="false"></div>
  <div class="rangee" style="justify-content:flex-end;gap:8px"><button type="button" class="btn btn-s" data-action="fermer-fenetre">Annuler</button><button type="submit" class="btn btn-p">Ajouter</button></div>
</form>`)

// La fenêtre ouverte, quelle que soit la page.
function dessinerFenetre() {
  const q = etat.fenetre
  if (!q) return ""
  if (q === "public") return fenetre(etat.departPublic ? (DEPARTS_PUBLIC.find(([id]) => id === etat.departPublic) ?? [])[2] : "Nouveau public", creationPublic())
  if (q === "machine") return fenetreMachine()
  if (q === "inviter") return fenetre("Inviter dans l'usine", etat.acces ? formulaireInviter() : html`<div class="chargement">Chargement…</div>`)
  if (q === "budget") return fenetreBudget()
  if (q.startsWith("integration-")) return fenetreIntegration(q.slice(12))
  if (q === "connecteur-ajouter") return fenetreAjoutConnecteur()
  if (q.startsWith("connecteur-")) return fenetreConnecteur(q.slice(11))
  return ""
}

const PICTOS_DIRECT = { lecture: "◇", ecriture: "✎", commande: "›", pensee: "…", plan: "☰", erreur: "✕", fin: "✓", info: "•", outil: "·" }
function dessinerDirect() {
  const d = etat.direct
  if (!d || d.projet !== etat.route.id) return html`<div class="aide">Connexion au direct…</div>`
  if (!d.lignes.length) return html`<div>${d.source === "verificateur" ? "Le vérificateur prépare l'application…" : "L'agent lit la tâche et prépare son travail…"}</div>`
  return html`${d.lignes.map((l) => html`<div class="d-${l.type}"><span aria-hidden="true">${PICTOS_DIRECT[l.type] ?? "·"}</span> ${l.texte}</div>`)}`
}
async function suivreDirect() {
  if (etat.route.vue !== "projet" || !$("#direct") || document.hidden) return
  try {
    const d = await api("GET", `projets/${etat.route.id}/direct`)
    etat.direct = { ...d, projet: etat.route.id }
  } catch {
    return
  }
  const zone = $("#direct")
  if (!zone) return
  const enBas = zone.scrollTop + zone.clientHeight >= zone.scrollHeight - 30
  zone.innerHTML = dessinerDirect()[BRUT]
  if (enBas) zone.scrollTop = zone.scrollHeight
}
setInterval(suivreDirect, 3000)

const TYPES_HISTO = { demande: "Demande", validation: "Validation", decision: "Décision", production: "Mise en ligne", abandon: "Abandon", cycle: "Aperçu", plan: "Plan", domaine: "Adresse web", corrections: "Corrections", remarque: "Remarque", escalade: "Décision demandée", erreur: "Problème", relance: "Relance", reglage: "Réglage" }
const PICTOS_HISTO = { demande: "✎", validation: "✓", decision: "◆", production: "↗", abandon: "✕", cycle: "▣", plan: "☰", domaine: "@", corrections: "↺", remarque: "❝", escalade: "!", erreur: "!", relance: "↻", reglage: "⚙" }
const FILTRES_HISTO = [["", "Tout"], ["demande", "Demandes"], ["validation", "Validations"], ["decision", "Décisions"], ["production", "Mises en ligne"], ["erreur", "Problèmes"], ["reglage", "Réglages"]]
const dateDe = (le) => new Date(String(le).replace(" ", "T") + (String(le).includes("Z") ? "" : "Z"))
function jourDe(le) {
  const d = dateDe(le)
  if (isNaN(d)) return "Date inconnue"
  const j = (x) => x.toLocaleDateString("fr-FR")
  const hier = new Date(Date.now() - 864e5)
  if (j(d) === j(new Date())) return "Aujourd'hui"
  if (j(d) === j(hier)) return "Hier"
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })
}

// L'historique se lit comme un fil, groupé par jour, une phrase par évènement (Square, Plane).
function vueHistorique() {
  const h = etat.historique
  const projets = etat.resume?.projets ?? []
  const jours = []
  for (const x of h ?? []) {
    const j = jourDe(x.le)
    if (jours.at(-1)?.[0] !== j) jours.push([j, []])
    jours.at(-1)[1].push(x)
  }
  return html`
    <div><h1>Historique</h1><p class="chapeau">Qui a fait quoi, et quand. Les 200 derniers évènements.</p></div>
    <div class="rangee" style="gap:8px">
      <div class="rangee" role="group" aria-label="Filtrer par type" style="gap:6px">${FILTRES_HISTO.map(([k, nom]) => html`<button type="button" class="filtre" data-action="filtre-histo" data-id="${k}" aria-pressed="${String(etat.histoFiltre.type === k)}">${nom}</button>`)}</div>
      <label class="cache" for="h-projet">Projet</label>
      <select id="h-projet" class="champ champ-petit" data-filtre-histo="projet"><option value="">Tous les projets</option>${projets.map((p) => html`<option value="${p.id}" ${String(p.id) === etat.histoFiltre.projet ? "selected" : ""}>${p.nom ?? `Projet ${p.id}`}</option>`)}</select>
    </div>
    ${!h ? html`<div class="chargement">Chargement…</div>` : h.length ? jours.map(([jour, items]) => html`<section class="pile" style="gap:8px" aria-label="${jour}">
      <h2 class="surtitre">${jour}</h2>
      <ol class="fil carte">${items.map((x) => html`<li class="${["erreur", "escalade"].includes(x.type) ? "alerte" : ["production", "validation"].includes(x.type) ? "ok" : ""}">
        <span class="fil-picto" aria-hidden="true">${PICTOS_HISTO[x.type] ?? "•"}</span>
        <div style="flex:1;min-width:0">
          <div><strong>${x.par ?? "L'usine"}</strong> <span class="aide">· ${TYPES_HISTO[x.type] ?? x.type}${x.projet_id ? "" : " · l'usine"}</span>${x.projet_id ? html` <span class="aide">·</span> <a class="lien-projet" href="#/projets/${x.projet_id}">${x.projet ?? `Projet ${x.projet_id}`}</a>` : ""}</div>
          <div class="fil-texte">${nettoyer(x.message.length > 280 ? x.message.slice(0, 280) + "…" : x.message)}</div>
        </div>
        ${isNaN(dateDe(x.le)) ? "" : html`<time class="aide" datetime="${dateDe(x.le).toISOString()}">${dateDe(x.le).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</time>`}
      </li>`)}</ol></section>`)
    : html`<div class="carte vide">Rien pour ce choix.</div>`}`
}

// --- Rendu et chargement ------------------------------------------------------------------
let dernierCote = ""
function rendre() {
  const vue = { accueil: vueAccueil, projets: vueProjets, projet: vueProjet, reglages: vueReglages, personas: vuePersonas, persona: vuePersona, demarrer: vueDemarrer }[etat.route.vue]
  const m = $("#principal")
  // Garder le défilement du journal s'il était en bas.
  const j = $("#journal")
  const enBas = !j || j.scrollTop + j.clientHeight >= j.scrollHeight - 20
  const a = document.activeElement
  const cleFocus = a && m.contains(a) && a !== m ? ["action", "id", "quoi", "choix", "hote"].map((k) => a.dataset?.[k] ?? "").join("|") + "|" + (a.id ?? "") : null
  // La taille donnée à la main à un champ (poignée en bas à droite) survit au rafraîchissement.
  const tailles = new Map([...document.querySelectorAll("#vue textarea[id]")].filter((t) => t.style.height).map((t) => [t.id, t.style.height]))
  $("#vue").innerHTML = html`${vue()}${listeFlottante()}${dessinerFenetre()}`[BRUT]
  for (const [id, h] of tailles) { const t = document.getElementById(id); if (t) t.style.height = h }
  document.querySelector(".app").classList.toggle("plein-ecran", etat.route.vue === "demarrer")
  afficherMessages()
  if (cleFocus) {
    const cible = [...m.querySelectorAll("button, a, input, select, textarea")].find((x) => ["action", "id", "quoi", "choix", "hote"].map((k) => x.dataset?.[k] ?? "").join("|") + "|" + (x.id ?? "") === cleFocus)
    cible?.focus({ preventScroll: true })
  }
  const j2 = $("#journal")
  if (j2 && enBas) j2.scrollTop = j2.scrollHeight
  const d2 = $("#direct")
  if (d2) {
    d2.scrollTop = d2.scrollHeight
    if (!etat.direct || etat.direct.projet !== etat.route.id) suivreDirect()
  }
  // Premiers pas quitte le menu une fois tout l'essentiel fait (l'assistant se rouvre depuis les Réglages).
  const pp = document.querySelector("[data-nav=demarrer]")
  if (pp) pp.hidden = Boolean(etat.premiersPas?.termine) && etat.route.vue !== "demarrer"
  const liste = listeProjetsCote()[BRUT]
  if (liste !== dernierCote) { $("#liste-projets").innerHTML = liste; dernierCote = liste }
  for (const a of document.querySelectorAll(".nav a, .projets-cote [data-nav]")) {
    const actif = a.dataset.nav === ({ persona: "personas" }[etat.route.vue] ?? etat.route.vue)
    if (actif) a.setAttribute("aria-current", "page")
    else a.removeAttribute("aria-current")
  }
  const r = etat.resume
  if (r) {
    $("#base").textContent = r.usine.base
    $("#cote-bas").innerHTML = html`${r.usine.mise_a_jour?.disponible ? html`<a href="#/reglages/etat" class="carte" style="display:block;padding:12px;color:var(--encre);text-decoration:none"><strong style="display:block">Mise à jour disponible</strong><span class="aide">${r.usine.mise_a_jour.disponible} changement(s)</span></a>` : ""}
      ${"Notification" in window && Notification.permission === "default" ? html`<button type="button" class="btn btn-s btn-petit" data-action="notifications">Me prévenir des décisions</button>` : ""}
      ${"Notification" in window && Notification.permission === "denied" ? html`<span class="aide">Notifications bloquées dans le navigateur</span>` : ""}
      <a href="${r.usine.portail}" target="_blank" rel="noopener">Mes applications</a><span class="aide" id="moi"></span>`[BRUT]
    if (etat.moi) $("#moi").textContent = `${etat.moi.email} · administrateur`
  }
}

async function charger({ silencieux = false } = {}) {
  try {
    const r = etat.route
    const n = ++etat.numero
    const frais = () => n === etat.numero
    // Chaque partie s'affiche dès qu'elle arrive : une page lente ne bloque pas le reste.
    const taches = [api("GET", "resume").then((x) => { if (frais()) { etat.resume = x; prevenir(x); rendre() } })]
    const sec = r.vue === "reglages" ? r.section : null
    const charge = (chemin, cle) => taches.push(api("GET", chemin).then((x) => { if (frais()) { etat[cle] = x; rendre() } }))
    if (r.vue === "accueil" && !etat.estimation) charge("estimation", "estimation")
    if (["accueil", "personas", "projet"].includes(r.vue)) taches.push(api("GET", "personas").then((x) => { if (frais()) { etat.personas = x.personas; rendre() } }))
    if (r.vue === "persona") charge(`personas/${r.id}`, "persona")
    if (sec === "historique") charge(`historique?projet=${encodeURIComponent(etat.histoFiltre.projet)}&type=${encodeURIComponent(etat.histoFiltre.type)}`, "historique")
    if (r.vue === "projet") charge(`projets/${r.id}`, "projet")
    // Le bilan de santé nourrit la pastille du haut : une fois par minute suffit, hors des pages qui le détaillent.
    if (["utilisation", "etat"].includes(sec) || Date.now() - etat.santeLe > 60_000) taches.push(api("GET", "sante").then((x) => { etat.sante = x; etat.santeLe = Date.now(); rendre() }))
    if (sec === "equipe" || r.vue === "demarrer") charge("acces", "acces")
    if (["integrations", "utilisation", "regles"].includes(sec) || r.vue === "demarrer") charge("reglages", "reglages")
    if (sec === "integrations" || r.vue === "demarrer") charge("fournisseurs", "fournisseurs")
    if (sec === "integrations" || r.vue === "personas") taches.push(api("GET", "drive").catch(() => ({ configure: false })).then((x) => { if (frais()) { etat.drive = x; rendre() } }))
    if (sec === "connecteurs") taches.push(api("GET", "connecteurs").catch(() => ({ indisponible: true, connecteurs: [] })).then((x) => { if (frais()) { etat.connecteurs = x; rendre() } }))
    if (!etat.premiersPas || ["accueil", "demarrer", "reglages"].includes(r.vue)) taches.push(api("GET", "premiers-pas").then((x) => {
      if (!frais()) return
      etat.premiersPas = x
      // Une usine neuve s'ouvre sur ses premiers pas.
      if (r.vue === "accueil" && !location.hash && !x.termine && !x.masque && !etat.premiersPasVus) { etat.premiersPasVus = true; location.hash = "#/demarrer"; return }
      rendre()
    }))
    await Promise.all(taches)
  } catch (e) {
    if (!silencieux) etat.message = { type: "erreur", texte: e.message }
  }
  rendre()
}

// Pendant une saisie, on ne redessine pas (on perdrait le texte ou le curseur).
function enSaisie() {
  // Une section en cours de modification, ou une fenêtre ouverte : on ne redessine pas sous les doigts.
  if (etat.personaSection || etat.fenetre) return true
  const a = document.activeElement
  if (a && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName) && $("#principal").contains(a)) return true
  if (etat.planModifie || etat.confirmer || etat.occupe) return true
  if ([...document.querySelectorAll("#principal video")].some((v) => !v.paused)) return true
  if ([...document.querySelectorAll("#principal input[type=checkbox]")].some((x) => x.checked !== x.defaultChecked)) return true
  return [...document.querySelectorAll("#principal textarea, #principal input:not([type=radio]):not([type=checkbox])")].some((x) => x.value && x.defaultValue !== x.value)
}

function bloquer(oui) {
  for (const b of document.querySelectorAll("#vue button, #vue [type=submit]")) {
    if (oui && !b.disabled) {
      b.disabled = true
      b.dataset.occupe = "1"
    } else if (!oui && b.dataset.occupe) {
      b.disabled = false
      delete b.dataset.occupe
    }
  }
}

async function agir(fonction, { succes } = {}) {
  if (etat.occupe) return null
  etat.occupe = true
  bloquer(true)
  try {
    const r = await fonction()
    etat.message = { type: "ok", texte: succes ?? r?.message ?? "C'est fait." }
    etat.confirmer = null
    etat.occupe = false
    await charger({ silencieux: true })
    return r
  } catch (e) {
    etat.message = { type: "erreur", texte: e.message }
    afficherMessages()
    return null
  } finally {
    etat.occupe = false
    bloquer(false)
  }
}
const confirmer = (texte) => window.confirm(texte)

// Les réponses aux questions de l'analyste partent ensemble.
async function envoyerReponses() {
  const s = etat.questions
  const r = await agir(() => api("POST", `projets/${etat.projet.id}/reponses`, { reponses: s.reponses }), { succes: "Réponses transmises : l'analyste prépare le plan." })
  if (r) etat.questions = null
}

// La fiche d'un public, lue dans le formulaire de la section modifiée (une liste = une entrée
// par ligne). Ce qui n'est pas dans ce formulaire reste tel quel.
function lireFichePersona(f, p) {
  const d = new FormData(f)
  const base = p.fiche ?? {}
  const texte = (nom, defaut) => (d.has(nom) ? String(d.get(nom)).trim() : defaut ?? "")
  const liste = (nom, defaut) => (d.has(nom) ? String(d.get(nom)).split("\n").map((x) => x.trim()).filter(Boolean) : defaut ?? [])
  const parties = (l) => l.split("|").map((x) => x.trim())
  return {
    nom: texte("nom", p.nom),
    fiche: {
      ...base,
      resume: texte("resume", base.resume),
      problemes: d.has("problemes") ? liste("problemes").map((l) => { const [probleme, preuve = "", source = ""] = parties(l); const doc = /^document\s*:\s*/i.test(source); return { probleme, preuve, source: doc ? "" : source, document: doc ? source.replace(/^document\s*:\s*/i, "") : "" } }) : base.problemes ?? [],
      besoins: liste("besoins", base.besoins), demographie: liste("demographie", base.demographie), psychographie: liste("psychographie", base.psychographie), outils_actuels: liste("outils_actuels", base.outils_actuels),
      prix_acceptable: texte("prix_acceptable", base.prix_acceptable), objections: liste("objections", base.objections), canaux: liste("canaux", base.canaux),
      sources: d.has("sources") ? liste("sources").map((l) => { const x = parties(l); const ou = x.length > 1 ? x.slice(1).join("|") : x[0]; const doc = /^document\s*:\s*/i.test(ou); return { titre: x.length > 1 ? x[0] : "", url: doc ? "" : ou, document: doc ? ou.replace(/^document\s*:\s*/i, "") : "" } }) : base.sources ?? [],
    },
    hors_perimetre: liste("hors_perimetre", p.hors_perimetre),
    scenarios: etat.personaSection === "situations" ? [...f.querySelectorAll("[data-scenario]")].map((s) => {
      const v = (champ) => s.querySelector(`[data-champ=${champ}]`)?.value.trim() ?? ""
      return { titre: v("titre"), situation: v("situation"), etapes: v("etapes").split("\n").map((x) => x.trim()).filter(Boolean), attendu: v("attendu") }
    }) : p.scenarios ?? [],
  }
}

// Les adresses d'une invitation, séparées par des virgules, des points-virgules ou des espaces.
const adresses = (t) => String(t ?? "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)
function ajouterInvites(champ) {
  const nouvelles = adresses(champ.value)
  const valides = nouvelles.filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))
  const refusees = nouvelles.filter((x) => !valides.includes(x))
  etat.invites = [...new Set([...etat.invites, ...valides])]
  rendre()
  const c = $("#inv-email")
  if (c) { c.value = refusees.join(", "); c.focus() }
  if (refusees.length) { etat.message = { type: "erreur", texte: `Adresse non reconnue : ${refusees.join(", ")}` }; afficherMessages() }
}

// Un fichier en base64, par morceaux (un gros fichier dépasserait la pile d'appels).
function enBase64(tampon) {
  const octets = new Uint8Array(tampon)
  let binaire = ""
  for (let i = 0; i < octets.length; i += 0x8000) binaire += String.fromCharCode(...octets.subarray(i, i + 0x8000))
  return btoa(binaire)
}
const PIECES = { max: 3, taille: 2 * 1024 * 1024, types: ["image/png", "image/jpeg", "image/webp", "application/pdf"], textes: /\.(md|markdown|txt)$/i }
const pieceAcceptee = (f) => PIECES.types.includes(f.type) || PIECES.textes.test(f.name)
document.addEventListener("change", (e) => {
  if (e.target.id === "pieces") {
    const choisis = [...e.target.files]
    const refuses = choisis.filter((f) => !pieceAcceptee(f) || f.size > PIECES.taille)
    const toutes = [...etat.pieces, ...choisis.filter((f) => !refuses.includes(f))]
    etat.pieces = toutes.slice(0, PIECES.max)
    if (refuses.length) etat.message = { type: "erreur", texte: `Non retenu : ${refuses.map((f) => f.name).join(", ")} (PNG, JPEG, WebP, PDF, Markdown ou texte, de 2 Mo au plus).` }
    else if (toutes.length > PIECES.max) etat.message = { type: "info", texte: `${PIECES.max} pièces jointes au plus : les suivantes n'ont pas été retenues.` }
    const texte = $("#demande")?.value
    rendre()
    if (texte) $("#demande").value = texte
  }
  if (e.target.dataset?.choix === "brique") etat.brique = e.target.value
  if (e.target.dataset?.choix === "persona") etat.personaChoisi = e.target.value || null
  if (e.target.dataset?.roleUtilisateur) {
    const champ = e.target
    agir(() => api("PATCH", `acces/utilisateurs/${champ.dataset.roleUtilisateur}`, { role: champ.value })).then((r) => { if (!r) { champ.value = champ.value === "admin" ? "membre" : "admin" } })
  }
  if (e.target.dataset?.filtreHisto) {
    etat.histoFiltre[e.target.dataset.filtreHisto] = e.target.value
    charger()
  }
})

// --- 3. Être prévenu : notification du navigateur et compteur dans l'onglet ------------------
function prevenir(resume) {
  const items = resume.a_traiter ?? []
  document.title = items.length ? `(${items.length}) Console de l'usine` : "Console de l'usine"
  const cles = new Set(items.map((x) => `${x.type}:${x.projet}:${x.titre}`))
  if (etat.vus) {
    const nouveaux = items.filter((x) => !etat.vus.has(`${x.type}:${x.projet}:${x.titre}`))
    if (nouveaux.length && "Notification" in window && Notification.permission === "granted") {
      for (const x of nouveaux.slice(0, 3)) {
        const n = new Notification(x.titre, { body: nettoyer(x.detail), tag: `usine-${x.type}-${x.projet}` })
        n.onclick = () => { window.focus(); location.hash = `#/projets/${x.projet}`; n.close() }
      }
    }
  }
  etat.vus = cles
}

// --- Plan modifiable --------------------------------------------------------------------
const nouvelleTache = () => ({ cle: `Tn${Math.random().toString(36).slice(2, 7)}`, titre: "Nouvelle tâche", description: "", criteres: [""], depend_de: [] })
const planCourant = () => (etat.planEdition && etat.planEditionId === etat.projet.id ? etat.planEdition : structuredClone(etat.projet.plan))

// Recopie ce qui a été tapé dans le plan en cours de modification.
function syncPlan(plan) {
  for (const el of document.querySelectorAll("[data-form=plan] [data-lot]")) {
    if (!["INPUT", "TEXTAREA"].includes(el.tagName)) continue
    const lot = plan.lots[Number(el.dataset.lot)]
    if (!lot) continue
    const t = el.dataset.tache !== undefined ? lot.taches[Number(el.dataset.tache)] : null
    const v = el.value
    if (!t && el.dataset.champ === "nom") lot.nom = v
    else if (!t && el.dataset.champ === "objectif") lot.objectif = v
    else if (t && el.dataset.critere !== undefined) t.criteres[Number(el.dataset.critere)] = v
    else if (t && el.dataset.champ === "titre") t.titre = v
    else if (t && el.dataset.champ === "description") t.description = v
    else if (t && el.dataset.champ === "depend") t.depend_de = (v.toUpperCase().match(/T\d+/g) ?? [])
  }
  return plan
}

// Numérote les tâches T1, T2… dans l'ordre ; une dépendance ne vise qu'une tâche placée avant.
function normaliserPlan(plan) {
  const nouvelles = new Map()
  let n = 0
  for (const lot of plan.lots) for (const t of lot.taches) nouvelles.set(t.cle, `T${++n}`)
  const avant = new Set()
  for (const lot of plan.lots) for (const t of lot.taches) {
    const cle = nouvelles.get(t.cle)
    t.depend_de = [...new Set((t.depend_de ?? []).map((k) => nouvelles.get(k)).filter((k) => k && avant.has(k)))]
    t.cle = cle
    avant.add(cle)
  }
  return plan
}

function editerPlan(modifier) {
  const plan = syncPlan(planCourant())
  if (modifier(plan) === false) return
  etat.planEdition = normaliserPlan(plan)
  etat.planEditionId = etat.projet.id
  etat.planModifie = true
  rendre()
}

// Les défauts visibles avant d'envoyer (le serveur revérifie tout).
function defautsPlan(plan) {
  const d = []
  plan.lots.forEach((lot, i) => {
    if (!lot.nom.trim()) d.push(`le lot ${i + 1} n'a pas de nom`)
    if (!lot.taches.length) d.push(`le lot ${i + 1} n'a plus de tâche : supprime-le ou ajoutes-en une`)
    for (const t of lot.taches) {
      if (!t.titre.trim()) d.push(`${t.cle} n'a pas de titre`)
      if (!t.criteres.some((c) => c.trim())) d.push(`${t.cle} n'a aucun critère d'acceptation`)
    }
  })
  if (!plan.lots.length) d.push("le plan n'a plus de lot")
  return d
}

// --- Évènements ----------------------------------------------------------------------------
// L'ordre des façons de se servir d'un moteur : changé tout de suite côté usine.
function changerModes(moteur, modifier) {
  const m = etat.fournisseurs?.moteurs.find((x) => x.id === moteur)
  if (!m) return
  const modes = modifier([...m.modes])
  return agir(() => api("PUT", `fournisseurs/modes/${moteur}`, { modes }))
}

// La connexion ChatGPT : le lien et le code arrivent du vérificateur, puis le résultat.
let suiviChatGPT = null
function suivreChatGPT() {
  clearInterval(suiviChatGPT)
  suiviChatGPT = setInterval(async () => {
    const x = await api("GET", "fournisseurs/chatgpt").catch(() => null)
    if (!x) return
    if (x.etat === "connecte" || x.etat === "echec" || x.etat === "aucune") {
      clearInterval(suiviChatGPT)
      etat.chatgpt = null
      if (x.message) etat.message = { type: x.etat === "connecte" ? "ok" : "erreur", texte: x.message }
      await charger({ silencieux: true })
      return
    }
    const avant = JSON.stringify(etat.chatgpt)
    etat.chatgpt = x
    if (JSON.stringify(x) !== avant && etat.route.vue === "reglages") rendre()
  }, 3000)
}

async function chargerDrive() {
  etat.drive = await api("GET", "drive").catch(() => ({ configure: false }))
  rendre()
}

async function chargerJetons() {
  etat.jetons = (await api("GET", "personas/jetons").catch(() => ({ jetons: [] }))).jetons
  rendre()
}

const ACTIONS = {
  palette: () => ouvrirPalette(),
  "premiers-pas": (el) => agir(() => api("PUT", "premiers-pas", { masque: el.dataset.quoi === "masquer" })),
  "github-oublier": () => {
    if (!confirmer("Déconnecter GitHub de l'usine ? Les projets en cours ne pourront plus pousser leur code tant qu'un compte n'est pas reconnecté.")) return
    return agir(() => api("DELETE", "github", {}))
  },
  "tester-fournisseurs": () => agir(() => api("POST", "fournisseurs/tester", {})),
  "retirer-identifiant": (el) => {
    if (!confirmer("Retirer cette valeur de la console ? Celle du serveur, s'il y en a une, reprendra.")) return
    return agir(() => api("DELETE", `fournisseurs/identifiants/${el.dataset.nom}`, {}))
  },
  "mode-monter": (el) => changerModes(el.dataset.moteur, (l) => { const i = l.indexOf(el.dataset.mode); if (i > 0) [l[i - 1], l[i]] = [l[i], l[i - 1]]; return l }),
  "mode-basculer": (el) => changerModes(el.dataset.moteur, (l) => (l.includes(el.dataset.mode) ? l.filter((x) => x !== el.dataset.mode) : [...l, el.dataset.mode])),
  "connecter-chatgpt": async () => {
    const r = await agir(() => api("POST", "fournisseurs/chatgpt", {}))
    if (r) { etat.chatgpt = { etat: "attente" }; rendre(); suivreChatGPT() }
  },
  "fermer-message": () => { etat.message = null; rendre() },
  video: () => agir(() => api("POST", `projets/${etat.projet.id}/video`, {}), { succes: "Génération lancée : la vidéo arrive ici dans quelques minutes." }),
  filtre: (el) => { etat.filtre = el.dataset.id; rendre() },
  "retirer-piece": (el) => { etat.pieces.splice(Number(el.dataset.id), 1); const t = $("#demande")?.value; rendre(); if (t) $("#demande").value = t },
  notifications: async () => {
    const r = await Notification.requestPermission().catch(() => "denied")
    etat.message = r === "granted" ? { type: "ok", texte: "C'est noté : une notification arrivera dès qu'une décision t'attend (onglet ouvert, même en arrière-plan)." } : { type: "info", texte: "Notifications refusées : le compteur dans le titre de l'onglet reste là." }
    rendre()
  },
  brique: (el) => { etat.brique = el.dataset.id; const t = $("#demande")?.value; rendre(); if (t) $("#demande").value = t },
  exemple: (el) => { $("#demande").value = el.dataset.texte; $("#demande").focus() },
  onglet: (el) => { etat.onglet = el.dataset.id; rendre() },
  confirmer: (el) => {
    etat.confirmer = el.dataset.quoi
    // Production et suppression : on montre la confirmation sans redessiner (les choix restent).
    const bloc = $(`#conf-${el.dataset.quoi}`)
    if (bloc) {
      bloc.hidden = false
      $(`#btn-${el.dataset.quoi}`).hidden = true
      bloc.querySelector("button")?.focus()
      return
    }
    rendre()
  },
  annuler: (el) => {
    const quoi = el.dataset.quoi
    etat.confirmer = null
    if (quoi && $(`#conf-${quoi}`)) {
      $(`#conf-${quoi}`).hidden = true
      $(`#btn-${quoi}`).hidden = false
      $(`#btn-${quoi} button`)?.focus()
      return
    }
    rendre()
  },
  usine: (el) => {
    const q = el.dataset.quoi
    if (q === "mettre-a-jour" && !confirmer("Mettre à jour l'usine ? Elle finit sa tâche en cours, se reconstruit et redémarre (quelques minutes).")) return
    if (q === "stop" && !confirmer("Arrêter l'usine après la tâche en cours ?")) return
    return agir(() => api("POST", `usine/${q}`, {}))
  },
  message: (el) => {
    const champ = $(`#${el.dataset.source}`)
    const texte = champ?.value.trim()
    if (!texte) return champ?.focus()
    return agir(() => api("POST", `projets/${etat.projet.id}/message`, { texte }))
  },
  corriger: () => {
    const texte = $("#corrections")?.value.trim()
    if (!texte) return $("#corrections")?.focus()
    return agir(() => api("POST", `projets/${etat.projet.id}/corriger`, { texte }), { succes: "Demande transmise : l'analyste enquête." })
  },
  decider: (el) => agir(() => api("POST", `escalades/${el.dataset.id}`, { choix: el.dataset.choix, texte: $(`#consigne-${el.dataset.id}`)?.value ?? "" }), { succes: "Décision transmise : l'usine reprend." }),
  "valider-plan": () => agir(() => api("POST", `projets/${etat.projet.id}/valider`, {}), { succes: etat.projet.reorientation ? "Réorientation validée : l'usine ouvre les nouvelles tâches et reprend la fabrication." : "Plan validé : l'usine crée le dépôt et commence le lot 1." }),
  "ouvrir-reorienter": () => {
    etat.reorienterOuvert = !etat.reorienterOuvert
    rendre()
    if (etat.reorienterOuvert) {
      $("#reorienter")?.scrollIntoView({ behavior: "smooth", block: "start" })
      $("#consigne-reorienter")?.focus({ preventScroll: true })
    }
  },
  reorienter: () => {
    const consigne = $("#consigne-reorienter")?.value.trim()
    if (!consigne) return $("#consigne-reorienter")?.focus()
    if (!confirmer("Réorienter le projet ? La fabrication s'arrête après la tâche en cours, le temps que tu valides le nouveau plan.")) return
    return agir(() => api("POST", `projets/${etat.projet.id}/reorienter`, { consigne, persona_id: $("#persona-reorienter")?.value || null }))
  },
  "annuler-reorientation": () => confirmer("Garder l'ancien plan ? La fabrication reprend là où elle s'était arrêtée.") && agir(() => api("POST", `projets/${etat.projet.id}/abandonner`, {})),
  "relancer-projet": () => agir(() => api("POST", `projets/${etat.projet.id}/relancer`, {}), { succes: "Relance lancée : cette page se met à jour toute seule." }),
  "ajouter-critere": (el) => {
    const [l, t] = [Number(el.dataset.lot), Number(el.dataset.tache)]
    editerPlan((plan) => { plan.lots[l].taches[t].criteres.push("") })
    const champs = document.querySelectorAll(`[data-lot="${l}"][data-tache="${t}"][data-critere]`)
    champs[champs.length - 1]?.focus()
  },
  "supprimer-critere": (el) => editerPlan((plan) => { plan.lots[Number(el.dataset.lot)].taches[Number(el.dataset.tache)].criteres.splice(Number(el.dataset.critere), 1) }),
  "ajouter-tache": (el) => {
    const l = Number(el.dataset.lot)
    editerPlan((plan) => { plan.lots[l].taches.push(nouvelleTache()) })
    const titres = document.querySelectorAll(`[data-lot="${l}"][data-champ="titre"]`)
    titres[titres.length - 1]?.select()
  },
  "supprimer-tache": (el) => editerPlan((plan) => { plan.lots[Number(el.dataset.lot)].taches.splice(Number(el.dataset.tache), 1) }),
  "monter-tache": (el) => editerPlan((plan) => {
    const [l, t] = [Number(el.dataset.lot), Number(el.dataset.tache)]
    const lot = plan.lots[l]
    if (t > 0) [lot.taches[t - 1], lot.taches[t]] = [lot.taches[t], lot.taches[t - 1]]
    else if (l > 0) plan.lots[l - 1].taches.push(lot.taches.shift())
    else return false
  }),
  "descendre-tache": (el) => editerPlan((plan) => {
    const [l, t] = [Number(el.dataset.lot), Number(el.dataset.tache)]
    const lot = plan.lots[l]
    if (t < lot.taches.length - 1) [lot.taches[t + 1], lot.taches[t]] = [lot.taches[t], lot.taches[t + 1]]
    else if (l < plan.lots.length - 1) plan.lots[l + 1].taches.unshift(lot.taches.pop())
    else return false
  }),
  "ajouter-lot": () => editerPlan((plan) => { plan.lots.push({ nom: "Nouveau lot", objectif: "", taches: [nouvelleTache()] }) }),
  "supprimer-lot": (el) => editerPlan((plan) => {
    const l = Number(el.dataset.lot)
    if (plan.lots[l].taches.length && !confirmer(`Supprimer le lot ${l + 1} et ses ${plan.lots[l].taches.length} tâche(s) ?`)) return false
    plan.lots.splice(l, 1)
  }),
  "monter-lot": (el) => editerPlan((plan) => {
    const l = Number(el.dataset.lot)
    if (l === 0) return false
    ;[plan.lots[l - 1], plan.lots[l]] = [plan.lots[l], plan.lots[l - 1]]
  }),
  "descendre-lot": (el) => editerPlan((plan) => {
    const l = Number(el.dataset.lot)
    if (l >= plan.lots.length - 1) return false
    ;[plan.lots[l + 1], plan.lots[l]] = [plan.lots[l], plan.lots[l + 1]]
  }),
  "annuler-plan": () => {
    if (!confirmer("Annuler toutes les modifications du plan ?")) return
    etat.planEdition = null
    etat.planModifie = false
    rendre()
  },
  abandonner: () => agir(() => api("POST", `projets/${etat.projet.id}/abandonner`, {})),
  supprimer: async () => {
    const r = await agir(() => api("POST", `projets/${etat.projet.id}/supprimer`, { confirme: true }))
    if (r?.ok) location.hash = "#/"
  },
  "retirer-domaine": (el) => confirmer(`Retirer le domaine ${el.dataset.hote} ? Il ne servira plus le produit.`) && agir(() => api("DELETE", `projets/${etat.projet.id}/domaines/${encodeURIComponent(el.dataset.hote)}`, {})),
  apercu: (el) => (el.dataset.quoi !== "retirer" || confirmer("Retirer l'aperçu maintenant ? Le prochain lot livré le remettra en ligne.")) && agir(() => api("POST", `projets/${etat.projet.id}/apercu/${el.dataset.quoi}`, {})),
  renvoyer: async (el) => {
    const r = await agir(() => api("POST", `acces/utilisateurs/${el.dataset.id}/invitation`, {}), { succes: "Nouveau lien d'invitation créé." })
    if (r) { etat.invitation = r.envoye ? "Invitation renvoyée par email (lien valable 72 h)." : `L'email n'est pas parti : transmets ce lien toi-même (personnel, 72 h) : ${r.lien}`; rendre() }
  },
  "retirer-personne": (el) => agir(() => api("DELETE", `acces/utilisateurs/${el.dataset.id}`, {}), { succes: "Accès retiré." }),
  revoquer: (el) => confirmer("Révoquer cette clé ? Les programmes qui l'utilisent seront refusés aussitôt.") && agir(() => api("DELETE", `acces/cles/${el.dataset.id}`, {}), { succes: "Clé révoquée." }),
  "copier-cle": async () => {
    try {
      await navigator.clipboard.writeText(etat.cleCreee)
      etat.message = { type: "ok", texte: "Clé copiée dans le presse-papiers." }
    } catch {
      etat.message = { type: "erreur", texte: "Copie impossible ici : sélectionne la clé et copie-la à la main." }
    }
    afficherMessages()
  },
  "fermer-cle": () => { etat.cleCreee = null; rendre() },
  // Passer de « décrire » à « terminer une application existante » garde ce qui a été écrit.
  depart: (el) => { const t = $("#demande")?.value; etat.depart = el.dataset.id; rendre(); if (t) $("#demande").value = t; $(etat.depart === "depot" ? "#adresse" : "#demande")?.focus() },
  menu: (el) => {
    const ouvert = $("#cote").classList.toggle("ouvert")
    el.setAttribute("aria-expanded", String(ouvert))
  },
  "voir-archives": () => { etat.filtre = "archives"; if (location.hash === "#/projets") rendre(); else location.hash = "#/projets" },
  fenetre: (el) => {
    etat.fenetre = el.dataset.quoi
    if (el.dataset.quoi === "public") etat.departPublic = null
    if (el.dataset.quoi === "machine") { etat.jetonCree = null; chargerJetons() }
    if (["public", "integration-drive"].includes(el.dataset.quoi) && !etat.drive) chargerDrive()
    if (el.dataset.quoi === "inviter" && !etat.acces) charger({ silencieux: true })
    if (el.dataset.quoi === "budget" && !etat.reglages) charger({ silencieux: true })
    rendre()
    // Le premier champ à remplir, sinon le premier bouton du contenu (pas « Fermer »).
    ;($(".fenetre form :is(input:not([type=hidden]), textarea)") ?? $(".fenetre > :not(.barre) button"))?.focus()
  },
  "fermer-fenetre": () => { etat.fenetre = null; etat.invites = []; etat.jetonCree = null; etat.departPublic = null; rendre() },
  "retirer-invite": (el) => { etat.invites.splice(Number(el.dataset.id), 1); rendre(); $("#inv-email")?.focus() },
  "fermer-invitations": () => { etat.invitation = null; rendre() },
  "depart-public": (el) => {
    etat.departPublic = el.dataset.id || null
    rendre()
    ;($(".fenetre form :is(input:not([type=hidden]):not([type=file]), textarea)") ?? $(".fenetre .depart"))?.focus()
  },
  "modele-persona": () => {
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([JSON.stringify(MODELE_PERSONA, null, 2)], { type: "application/json" }))
    a.download = "persona-modele.json"
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  },
  copier: async (el) => {
    const c = etat.jetonCree
    const commande = `curl -X POST ${location.origin}/api/import/personas -H "Authorization: Bearer ${c?.jeton ?? "usp_…"}" -H "Content-Type: application/json" --data @persona.json`
    const texte = { jeton: c?.jeton ?? "", commande, consigne: CONSIGNE_ASSISTANT(location.origin, null), "consigne-jeton": CONSIGNE_ASSISTANT(location.origin, c?.jeton), "drive-email": etat.drive?.email ?? "" }[el.dataset.quoi] ?? ""
    try {
      await navigator.clipboard.writeText(texte)
      etat.message = { type: "ok", texte: "Copié." }
    } catch {
      etat.message = { type: "erreur", texte: "La copie n'a pas marché : sélectionne le texte et copie-le à la main." }
    }
    afficherMessages()
  },
  "tester-drive": () => agir(() => api("POST", "drive/tester", {})),
  "retirer-drive": async () => {
    if (!confirmer("Débrancher Google Drive ? L'usine ne pourra plus lire les dossiers partagés. Tu pourras le rebrancher avec la même clé.")) return
    if (await agir(() => api("DELETE", "drive/compte", {}))) chargerDrive()
  },
  "retirer-jeton": async (el) => {
    if (!confirmer("Retirer ce jeton ? Ce qui l'utilise ne pourra plus envoyer de fiche.")) return
    if (await agir(() => api("DELETE", `personas/jetons/${el.dataset.id}`, {}))) chargerJetons()
  },
  "filtre-connecteurs": (el) => { etat.filtreConnecteurs = el.dataset.id; rendre() },
  "tester-connecteur": (el) => agir(() => api("POST", `connecteurs/${el.dataset.id}/tester`, {})),
  "retirer-cle-connecteur": (el) => {
    if (!confirmer("Retirer la clé de ce connecteur ? Il sera désactivé tant qu'une autre clé n'est pas collée.")) return
    return agir(() => api("DELETE", `connecteurs/${el.dataset.id}/cle`, {}))
  },
  "retirer-connecteur": async (el) => {
    if (!confirmer("Retirer ce connecteur ? Les IA ne pourront plus s'en servir.")) return
    if (await agir(() => api("DELETE", `connecteurs/${el.dataset.id}`, {}))) { etat.fenetre = null; rendre() }
  },
  "filtre-histo": (el) => { etat.histoFiltre.type = el.dataset.id; etat.historique = null; rendre(); charger() },
  "persona-section": (el) => { etat.personaSection = el.dataset.id || null; etat.personaScenarios = null; rendre(); $(`#sec-${el.dataset.id} ~ form`)?.querySelector("input, textarea")?.focus() },
  "construire-pour": (el) => { etat.personaChoisi = el.dataset.id; etat.depart = "zero"; location.hash = "#/nouveau" },
  "corriger-recette": () => {
    const garder = [...document.querySelectorAll("input[name=garder]:checked")].map((x) => Number(x.value))
    const ajout = $("#recette-ajout")?.value.trim() ?? ""
    if (!garder.length && !ajout) {
      etat.message = { type: "erreur", texte: "Coche au moins un point, ou ajoute une demande." }
      return afficherMessages()
    }
    return agir(() => api("POST", `projets/${etat.projet.id}/corriger-recette`, { garder, ajout }), { succes: "Transmis : l'analyste prépare un lot de corrections." })
  },
  "questions-aller": (el) => { noterReponse(); etat.questions.i = Number(el.dataset.id); rendre() },
  "questions-auto": () => {
    noterReponse()
    const s = etat.questions
    for (let i = s.i; i < s.reponses.length; i++) if (i > s.i || !s.reponses[i]?.libre) s.reponses[i] = { auChoix: true }
    return envoyerReponses()
  },
  "questions-envoyer": () => { noterReponse(); return envoyerReponses() },
  "plan-vue": (el) => { etat.planVue = el.dataset.id; rendre(); window.scrollTo({ top: 0 }) },
  "prod-reglages": () => {
    // Les choix déjà faits restent dans le formulaire : on bascule seulement l'affichage.
    etat.prodReglages = !etat.prodReglages
    const bloc = $("#prod-reglages")
    if (bloc) bloc.hidden = !etat.prodReglages
    const b = $("[data-action=prod-reglages]")
    if (b) b.textContent = etat.prodReglages ? "Masquer les réglages" : "Modifier les réglages"
  },
  "produit-lot": (el) => { etat.produit.lot = Number(el.dataset.id); etat.produit.i = 0; rendre() },
  "produit-capture": (el) => { etat.produit.i = Number(el.dataset.id); rendre() },
  copier: async (el) => {
    try {
      await navigator.clipboard.writeText(el.dataset.texte)
      etat.message = { type: "ok", texte: "Adresse copiée." }
    } catch {
      etat.message = { type: "erreur", texte: `Copie impossible ici : ${el.dataset.texte}` }
    }
    afficherMessages()
  },
  aller: (el) => {
    const cible = $(`#${el.dataset.cible}`)
    cible?.scrollIntoView({ behavior: "smooth", block: "center" })
    cible?.focus({ preventScroll: true })
  },
  "persona-valider": () => agir(() => api("POST", `personas/${etat.persona.id}/valider`, {})),
  "persona-approfondir": () => agir(() => api("POST", `personas/${etat.persona.id}/approfondir`, { consignes: $("#consignes-persona")?.value ?? "" })),
  "persona-supprimer": async () => {
    if (!confirmer(`Supprimer le persona « ${etat.persona.nom} » ?`)) return
    const r = await agir(() => api("DELETE", `personas/${etat.persona.id}`, {}))
    if (r?.ok) location.hash = "#/personas"
  },
  // Ajouter ou retirer un scénario : on garde ce qui a été saisi dans le formulaire.
  "persona-ajouter-scenario": () => {
    etat.personaScenarios = lireFichePersona($("[data-form=persona]"), etat.persona).scenarios.concat([{ titre: "", situation: "", etapes: [], attendu: "" }])
    rendre()
  },
  "persona-retirer-scenario": (el) => {
    etat.personaScenarios = lireFichePersona($("[data-form=persona]"), etat.persona).scenarios.filter((_, i) => i !== Number(el.dataset.id))
    rendre()
  },
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]")
  if (!el) return
  if (el.dataset.action === "confirmer" && el.dataset.quoi === "abandonner") {
    if (!window.confirm("Abandonner ce plan ? Rien n'a encore été créé.")) return
    return ACTIONS.abandonner(el)
  }
  e.preventDefault()
  ACTIONS[el.dataset.action]?.(el)
})

document.addEventListener("input", (e) => {
  if (e.target.closest("[data-form=plan]") && e.target.matches("[data-lot]") && !etat.planModifie) {
    etat.planEdition = syncPlan(planCourant())
    etat.planEditionId = etat.projet.id
    etat.planModifie = true
    // Activer « Enregistrer » sans tout redessiner.
    const b = $("[data-form=plan] button[type=submit]")
    if (b) b.disabled = false
    const v = $("[data-action=valider-plan]")
    if (v) v.disabled = true
  }
})

// Les fichiers choisis s'affichent sous le bouton (nom et taille), sans redessiner la fenêtre.
document.addEventListener("change", (e) => {
  const liste = e.target.dataset?.fichiers && document.getElementById(e.target.dataset.fichiers)
  if (!liste) return
  liste.innerHTML = [...e.target.files].map((x) => html`<li><span aria-hidden="true">▤</span> ${x.name} <span class="aide">· ${Math.max(1, Math.round(x.size / 1024))} Ko</span></li>`[BRUT]).join("")
})

document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-form]")
  if (!f) return
  e.preventDefault()
  const d = new FormData(f)
  const type = f.dataset.form
  if (type === "nouveau") {
    const prompt = String(d.get("prompt") ?? "").trim()
    const indication = etat.brique !== "webapp" ? `\n\n(Type de produit souhaité : ${BRIQUES[etat.brique]}.)` : ""
    const r = await agir(async () => {
      const pieces = await Promise.all(etat.pieces.map(async (f) => ({ nom: f.name, type: f.type, base64: enBase64(await f.arrayBuffer()) })))
      return api("POST", "projets", { prompt: prompt + indication, pieces, persona_id: d.get("persona_id") || null })
    }, { succes: "Demande envoyée : l'analyste prépare le plan." })
    if (r?.id) {
      etat.pieces = []
      location.hash = `#/projets/${r.id}`
    }
  }
  if (type === "reprendre") {
    const r = await agir(() => api("POST", "projets/reprendre", { adresse: d.get("adresse"), persona_id: d.get("persona_id") || null, mode: d.get("mode"), consigne: d.get("consigne") ?? "" }))
    if (r?.id) location.hash = `#/projets/${r.id}`
  }
  if (type === "persona-nouveau") {
    const fichiers = [...(f.querySelector("input[type=file]")?.files ?? [])]
    if (fichiers.length > 5) { etat.message = { type: "erreur", texte: "5 documents au plus." }; afficherMessages(); return }
    const r = await agir(async () => {
      const pieces = await Promise.all(fichiers.map(async (x) => ({ nom: x.name, type: x.type, base64: enBase64(await x.arrayBuffer()) })))
      return api("POST", "personas", { nom: d.get("nom"), brief: d.get("brief") ?? "", pieces, depot: d.get("depot") || null, drive: d.get("drive") || null })
    })
    if (r?.id) {
      etat.fenetre = null
      // Dans l'assistant, on reste sur place : la recherche continue pendant les étapes suivantes.
      if (etat.route.vue === "demarrer") rendre()
      else location.hash = `#/personas/${r.id}`
    }
  }
  if (type === "persona-importer") {
    const fichier = $("#persona-fiche")?.files?.[0]
    const texte = fichier ? await fichier.text() : String(d.get("json") ?? "").trim()
    let persona
    try {
      persona = JSON.parse(texte)
    } catch {
      etat.message = { type: "erreur", texte: texte ? "Ce n'est pas du JSON valide : compare-le au modèle." : "Choisis un fichier ou colle le contenu de la fiche." }
      afficherMessages()
      return
    }
    const r = await agir(() => api("POST", "personas/importer", { persona }))
    if (r?.id) { etat.fenetre = null; etat.departPublic = null; location.hash = `#/personas/${r.id}` }
  }
  if (type === "drive-compte") {
    const cle = String(d.get("cle") ?? "").trim()
    // La clé ne reste pas dans la page : le champ est vidé avant l'envoi.
    f.reset()
    if (cle && (await agir(() => api("PUT", "drive/compte", { cle })))) chargerDrive()
  }
  if (type === "jeton-persona") {
    const r = await agir(() => api("POST", "personas/jetons", { nom: d.get("nom") }))
    if (r?.jeton) { etat.jetonCree = { nom: String(d.get("nom")), jeton: r.jeton }; chargerJetons() }
  }
  if (type === "persona") {
    const r = await agir(() => api("PUT", `personas/${etat.persona.id}`, lireFichePersona(f, etat.persona)), { succes: "Section enregistrée." })
    if (r) {
      etat.personaScenarios = null
      etat.personaSection = null
      rendre()
    }
  }
  if (type === "plan") {
    const plan = normaliserPlan(syncPlan(planCourant()))
    etat.planEdition = plan
    etat.planEditionId = etat.projet.id
    for (const lot of plan.lots) for (const t of lot.taches) t.criteres = t.criteres.map((c) => c.trim()).filter(Boolean)
    const defauts = defautsPlan(plan)
    if (defauts.length) {
      etat.message = { type: "erreur", texte: `Avant d'enregistrer : ${defauts.slice(0, 4).join(" ; ")}.` }
      return afficherMessages()
    }
    const r = await agir(() => api("PUT", `projets/${etat.projet.id}/plan`, { plan }), { succes: "Plan enregistré. Tu peux le valider." })
    if (r) {
      etat.planModifie = false
      etat.planEdition = null
      await charger({ silencieux: true })
    }
  }
  if (type === "production") {
    await agir(() => api("POST", `projets/${etat.projet.id}/production`, {
      confirme: true, donnees: d.get("donnees"), emails: d.get("emails"), acces: d.get("acces"), horloge: d.get("horloge"), destinataires_autorises: d.get("destinataires_autorises") ?? "",
    }), { succes: "Mise en production lancée : suis-la dans le journal." })
  }
  if (type === "domaine") await agir(() => api("POST", `projets/${etat.projet.id}/domaines`, { hote: d.get("hote") }))
  if (type === "inviter") {
    const emails = [...new Set([...etat.invites, ...adresses(d.get("saisie"))])]
    if (!emails.length) {
      etat.message = { type: "erreur", texte: "Ajoute au moins une adresse email." }
      return afficherMessages()
    }
    // Une invitation par personne ; un refus (compte existant) n'arrête pas les suivantes.
    const r = await agir(async () => {
      const resultats = []
      for (const email of emails) resultats.push(await api("POST", "acces/utilisateurs", { email, role: d.get("role"), applis: d.getAll("applis") }).then((x) => ({ email, ...x })).catch((e) => ({ email, erreur: e.message })))
      return resultats
    })
    if (r) {
      const faites = r.filter((x) => !x.erreur).length
      etat.message = { type: faites ? "ok" : "erreur", texte: faites ? `${faites} invitation${faites > 1 ? "s" : ""} créée${faites > 1 ? "s" : ""}.` : "Aucune invitation n'a pu être créée." }
      etat.invitation = r
      etat.invites = []
      etat.fenetre = null
      rendre()
    }
  }
  if (type === "github") {
    const organisation = d.get("cible") === "org" ? String(d.get("organisation") ?? "").trim() : ""
    if (d.get("cible") === "org" && !organisation) {
      etat.message = { type: "erreur", texte: "Indique le nom de l'organisation GitHub." }
      return afficherMessages()
    }
    const r = await agir(() => api("POST", "github/connexion", { organisation }), { succes: "Direction GitHub…" })
    if (r?.action) {
      // Le manifeste part vers GitHub par un formulaire (c'est ce que GitHub attend).
      const envoi = document.createElement("form")
      envoi.method = "post"
      envoi.action = r.action
      const champ = document.createElement("input")
      champ.type = "hidden"
      champ.name = "manifest"
      champ.value = r.manifeste
      envoi.append(champ)
      document.body.append(envoi)
      envoi.submit()
    }
  }
  if (type === "connecteur") {
    const roles = d.getAll("roles")
    const actif = e.submitter?.value !== "non"
    if (actif && !roles.length) {
      etat.message = { type: "erreur", texte: "Coche au moins une IA qui peut s'en servir." }
      afficherMessages()
      return
    }
    const r = await agir(() => api("PUT", `connecteurs/${f.dataset.id}`, { actif, roles }), { succes: actif ? "C'est enregistré : les IA s'en servent dès leur prochaine tâche." : "Connecteur désactivé." })
    if (r) { etat.fenetre = null; rendre() }
  }
  if (type === "cle-connecteur") {
    const valeur = String(d.get("valeur") ?? "").trim()
    f.reset()
    if (valeur) await agir(() => api("PUT", `connecteurs/${f.dataset.id}/cle`, { valeur }), { succes: "Clé enregistrée. Tu peux maintenant activer le connecteur." })
  }
  if (type === "connecteur-ajouter") {
    const cle = String(d.get("cle") ?? "").trim()
    $("#cx-cle").value = ""
    const r = await agir(() => api("POST", "connecteurs", { nom: String(d.get("nom") ?? "").trim(), adresse: String(d.get("adresse") ?? "").trim(), cle: cle || null }))
    if (r?.id) { etat.fenetre = `connecteur-${r.id}`; rendre() }
  }
  if (type === "identifiant") {
    const valeur = String(d.get("valeur") ?? "").trim()
    // La valeur ne reste pas dans la page : le champ est vidé avant l'envoi.
    f.reset()
    if (valeur) await agir(() => api("PUT", `fournisseurs/identifiants/${f.dataset.nom}`, { valeur }))
  }
  if (type === "modeles") {
    await agir(() => api("PUT", "fournisseurs/modeles", Object.fromEntries([...d.entries()].map(([k, v]) => [k, String(v).trim()]))))
  }
  if (type === "couts") {
    const r = await agir(() => api("PUT", "reglages/couts", { budget_mensuel: d.get("budget_mensuel"), budget_par_projet: d.get("budget_par_projet"), serveur_mensuel: d.get("serveur_mensuel"), abonnements: d.getAll("abonnement") }))
    if (r) { etat.fenetre = null; etat.santeLe = 0; await charger({ silencieux: true }) }
  }
  if (type === "cle") {
    const r = await agir(() => api("POST", "acces/cles", { nom: d.get("nom"), applis: d.getAll("applis") }), { succes: "Clé créée." })
    if (r?.cle) { etat.cleCreee = r.cle; rendre() }
  }
})

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && etat.fenetre && !$("#palette").open) { ACTIONS["fermer-fenetre"](); return }
  if (e.target.matches?.("[data-saisie-invites]") && ["Enter", ","].includes(e.key) && e.target.value.trim()) {
    e.preventDefault()
    return ajouterInvites(e.target)
  }
  const onglet = e.target.closest?.("[role=tab]")
  if (!onglet || !["ArrowLeft", "ArrowRight"].includes(e.key)) return
  const tous = [...document.querySelectorAll("[role=tab]")]
  const i = (tous.indexOf(onglet) + (e.key === "ArrowRight" ? 1 : -1) + tous.length) % tous.length
  etat.onglet = tous[i].dataset.id
  rendre()
  $(`#onglet-${etat.onglet}`)?.focus()
})
document.addEventListener("toggle", (e) => {
  if (e.target.id === "zone-sensible") etat.detailsOuvert = e.target.open
  if (e.target.id === "reorienter") etat.reorienterOuvert = e.target.open
  if (e.target.id === "technique") etat.techniqueOuvert = e.target.open
}, true)

// --- Palette de commandes (Ctrl K) ----------------------------------------------------------
let choixPalette = 0
function entreesPalette(filtre) {
  const f = filtre.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
  const projets = (etat.resume?.projets ?? []).filter((p) => p.statut !== "abandonne").map((p) => ({ texte: p.nom, aide: (STATUTS[p.statut] ?? [p.statut])[0], aller: `#/projets/${p.id}` }))
  const commandes = [
    { texte: "Nouveau projet", aide: "commande", aller: "#/nouveau" },
    { texte: "Projets", aide: "page", aller: "#/" },
    { texte: "Publics : pour qui on construit", aide: "page", aller: "#/personas" },
    { texte: "Intégrations : IA, GitHub, Slack", aide: "réglages", aller: "#/reglages/integrations" },
    { texte: "Connecteurs : des outils pour les IA", aide: "réglages", aller: "#/reglages/connecteurs" },
    { texte: "Équipe : inviter quelqu'un", aide: "réglages", aller: "#/reglages/equipe" },
    { texte: "Utilisation et budget", aide: "réglages", aller: "#/reglages/utilisation" },
    { texte: "État de l'usine", aide: "réglages", aller: "#/reglages/etat" },
    { texte: "Historique : qui a fait quoi", aide: "réglages", aller: "#/reglages/historique" },
    { texte: "Premiers pas", aide: "assistant", aller: "#/demarrer" },
    { texte: "Mettre l'usine en pause", aide: "commande", faire: () => confirmer("Mettre l'usine en pause ? Elle termine ce qu'elle fait, puis s'arrête.") && agir(() => api("POST", "usine/stop", {})) },
    { texte: "Reprendre l'usine", aide: "commande", faire: () => agir(() => api("POST", "usine/reprendre", {})) },
    { texte: "Mettre à jour l'usine", aide: "commande", faire: () => confirmer("Mettre à jour l'usine ? Elle finit sa tâche en cours, se reconstruit et redémarre.") && agir(() => api("POST", "usine/mettre-a-jour", {})) },
  ]
  return [...commandes, ...projets].filter((x) => !f || x.texte.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").includes(f)).slice(0, 12)
}
function dessinerPalette() {
  const liste = entreesPalette($("#palette-saisie").value)
  choixPalette = Math.min(choixPalette, Math.max(0, liste.length - 1))
  $("#palette-liste").innerHTML = liste.map((x, i) => html`<li role="option" id="palette-${i}" aria-selected="${String(i === choixPalette)}"><button type="button" tabindex="-1" aria-selected="${String(i === choixPalette)}" data-i="${i}">${x.texte}<small>${x.aide}</small></button></li>`[BRUT]).join("") || `<li class="vide" role="option" aria-disabled="true">Rien ne correspond.</li>`
  $("#palette-saisie").setAttribute("aria-activedescendant", liste.length ? `palette-${choixPalette}` : "")
  return liste
}
function executerPalette(i) {
  const x = entreesPalette($("#palette-saisie").value)[i]
  if (!x) return
  $("#palette").close()
  if (x.aller) location.hash = x.aller
  else x.faire()
}
function ouvrirPalette() {
  $("#palette-saisie").value = ""
  choixPalette = 0
  dessinerPalette()
  $("#palette").showModal()
}
$("#palette-saisie").addEventListener("input", () => { choixPalette = 0; dessinerPalette() })
$("#palette-saisie").addEventListener("keydown", (e) => {
  const n = entreesPalette($("#palette-saisie").value).length
  if (e.key === "ArrowDown") { choixPalette = (choixPalette + 1) % Math.max(1, n); dessinerPalette(); e.preventDefault() }
  if (e.key === "ArrowUp") { choixPalette = (choixPalette - 1 + n) % Math.max(1, n); dessinerPalette(); e.preventDefault() }
  if (e.key === "Enter") { executerPalette(choixPalette); e.preventDefault() }
})
$("#palette-liste").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-i]")
  if (b) executerPalette(Number(b.dataset.i))
})
$("#palette").addEventListener("click", (e) => { if (e.target === $("#palette")) $("#palette").close() })
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); ouvrirPalette() }
})

// --- Démarrage ---------------------------------------------------------------------------
window.addEventListener("hashchange", () => {
  etat.route = lireRoute()
  $("#cote").classList.remove("ouvert")
  $("[data-action=menu]")?.setAttribute("aria-expanded", "false")
  etat.message = null
  etat.confirmer = null
  etat.planModifie = false
  etat.planEdition = null
  etat.cleCreee = null
  etat.invitation = null
  etat.personaScenarios = null
  etat.personaSection = null
  etat.fenetre = null
  etat.invites = []
  // Chaque projet s'ouvre sur le plan en lecture, les réglages de mise en ligne repliés.
  etat.planVue = "lecture"
  etat.prodReglages = false
  etat.reorienterOuvert = false
  if (etat.route.vue !== "projet") etat.onglet = null
  etat.direct = null
  rendre()
  charger()
  window.scrollTo(0, 0)
  if (etat.route.nouveau) $("#demande")?.focus()
})
etat.route = lireRoute()
api("GET", "moi").then((m) => { etat.moi = m; rendre() }).catch(() => {})
charger()
// La page se met à jour toute seule (toutes les 5 s sur un projet, 15 s ailleurs), sauf pendant une saisie.
let dernier = 0
setInterval(() => {
  const pas = ["projet", "persona"].includes(etat.route.vue) ? 5000 : 15000
  if (Date.now() - dernier < pas || document.hidden || enSaisie() || $("#palette").open) return
  dernier = Date.now()
  charger({ silencieux: true })
}, 1000)
