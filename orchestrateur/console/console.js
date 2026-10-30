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
  route: { vue: "projets" },
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
}

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
  if (h.startsWith("/nouveau")) return { vue: "nouveau" }
  const mp = h.match(/^\/personas\/(\d+)/)
  if (mp) return { vue: "persona", id: Number(mp[1]) }
  if (h.startsWith("/personas")) return { vue: "personas" }
  if (h.startsWith("/sante")) return { vue: "sante" }
  if (h.startsWith("/acces")) return { vue: "acces" }
  if (h.startsWith("/reglages")) return { vue: "reglages" }
  if (h.startsWith("/historique")) return { vue: "historique" }
  if (h.startsWith("/demarrer")) return { vue: "demarrer" }
  return { vue: "projets" }
}

// --- Vues ----------------------------------------------------------------------------
function barreHaut() {
  const u = etat.resume?.usine
  const occupe = u?.taches_en_cours ?? 0
  return html`<div class="barre">
    <button type="button" class="recherche" data-action="palette">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
      <span style="flex:1">Rechercher un projet ou une page…</span><span class="touche mono">Ctrl K</span>
    </button>
    ${u ? (u.arretee
      ? html`<div class="rangee"><span class="etat-usine" style="color:var(--signal)"><span class="point alerte"></span>Usine en pause${occupe ? " après ce qu'elle termine" : ""}</span><button type="button" class="btn btn-s btn-petit" data-action="usine" data-quoi="reprendre">Reprendre</button></div>`
      : html`<div class="etat-usine"><span class="point"></span>${occupe ? "L'usine travaille" : "L'usine est au repos"}</div>`) : ""}
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

function bandeauPremiersPas() {
  const pp = etat.premiersPas
  if (!pp || pp.termine || pp.masque) return ""
  const e = prochaineEtape(pp)
  return html`<section class="carte carte-p barre" style="gap:16px;flex-wrap:wrap;border-color:var(--accent)" aria-label="Premiers pas">
    <div style="flex:1;min-width:240px"><div class="aide">Premiers pas · ${pp.faites} sur ${pp.total}</div><strong>${e ? e.titre : "Presque prêt"}</strong><div class="aide">${e?.detail ?? ""}</div></div>
    <div class="rangee">${e ? html`<a class="btn btn-p" href="${e.aller}">${e.action}</a>` : ""}<a class="btn btn-s" href="#/demarrer">Voir toutes les étapes</a></div>
  </section>`
}

function vueDemarrer() {
  const pp = etat.premiersPas
  if (!pp) return html`${barreHaut()}<div class="chargement">Chargement…</div>`
  const e = prochaineEtape(pp)
  return html`
    ${barreHaut()}
    <div><h1>Premiers pas</h1><p class="chapeau">${pp.termine ? "L'usine est prête : tout l'essentiel est fait. Les étapes facultatives restent là si tu en as besoin." : `${pp.faites} étape${pp.faites > 1 ? "s" : ""} sur ${pp.total} pour que l'usine soit prête. Tout se fait ici, dans la console.`}</p></div>
    ${messageGlobal()}
    <div class="jauge ${pp.termine ? "verte" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="${pp.total}" aria-valuenow="${pp.faites}" aria-label="Avancement des premiers pas"><div style="width:${Math.round((pp.faites / pp.total) * 100)}%"></div></div>
    <ol class="pile" style="gap:12px;list-style:none;padding:0;margin:0">${pp.etapes.map((x, i) => html`<li class="carte carte-p barre" style="gap:16px;flex-wrap:wrap;${x === e ? "border-color:var(--accent)" : ""}">
      <div class="rangee" style="flex:1;min-width:240px;flex-wrap:nowrap;align-items:flex-start;gap:14px">
        <span class="badge ${x.fait ? "vert" : x.obligatoire ? "orange" : ""}" style="min-width:2.2em;text-align:center">${x.fait ? "✓" : i + 1}</span>
        <div><strong>${x.titre}</strong>${x.obligatoire ? "" : html` <span class="aide">(facultatif)</span>`}<div class="aide">${x.detail}</div></div>
      </div>
      ${x.fait ? html`<a class="btn btn-s" href="${x.aller}">Revoir</a>` : html`<a class="btn ${x === e ? "btn-p" : "btn-s"}" href="${x.aller}">${x.action}</a>`}
    </li>`)}</ol>
    <div class="rangee">${pp.masque ? html`<button type="button" class="btn btn-s" data-action="premiers-pas" data-quoi="afficher">Afficher le rappel sur la page Projets</button>` : html`<button type="button" class="btn btn-s" data-action="premiers-pas" data-quoi="masquer">Ne plus afficher le rappel</button>`}<a class="btn btn-s" href="#/">Aller aux projets</a></div>`
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
    ${bandeauPremiersPas()}
    ${saisieAccueil()}
    ${r.a_traiter.length ? html`<section aria-labelledby="a-traiter" class="pile">
      <h2 id="a-traiter" class="surtitre">À traiter · ${r.a_traiter.length}</h2>
      <div class="grille">${r.a_traiter.map((x) => html`<a class="a-traiter" href="#/projets/${x.projet}">
        <span class="icone">${ICONES[x.type] ?? ICONES.decision}</span>
        <span style="flex:1;min-width:0"><strong>${x.titre}</strong><span>${x.detail}</span></span>
        <em>${x.type === "plan" ? "Relire" : x.type === "livre" ? "Décider" : "Répondre"}</em></a>`)}</div>
    </section>` : ""}
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
        })}</tbody></table></div>` : html`<div class="vide">${r.projets.length ? "Aucun projet dans ce filtre." : html`Aucun projet pour l'instant. <a href="#/nouveau">Lance le premier</a>.`}</div>`}
    </section>
    <section class="grille" aria-label="Résumé de l'usine">
      <a class="carte carte-p" href="#/sante" style="text-decoration:none;color:inherit"><div class="aide">Budget du mois</div><div style="font-size:22px;font-weight:700">${r.couts.pct !== null ? `${r.couts.pct} % utilisé` : r.couts.mois}</div><div class="aide">${r.couts.budget ? `${r.couts.mois} sur ${r.couts.budget} (équivalent API)` : "pas de budget mensuel"}</div></a>
      <a class="carte carte-p" href="#/sante" style="text-decoration:none;color:inherit"><div class="aide">Serveur</div><div style="font-size:22px;font-weight:700">${r.serveur?.disque !== null && r.serveur ? `Disque ${r.serveur.disque} %` : "—"}</div><div class="aide">${r.serveur?.memoire !== null && r.serveur ? `mémoire ${r.serveur.memoire} %` : ""}</div></a>
      <a class="carte carte-p" href="#/sante" style="text-decoration:none;color:inherit"><div class="aide">Version de l'usine</div><div style="font-size:22px;font-weight:700">${r.usine.mise_a_jour?.disponible ? "Mise à jour disponible" : "À jour"}</div><div class="aide">${r.usine.mise_a_jour?.version ? `version ${r.usine.mise_a_jour.version}` : ""}</div></a>
    </section>`
}

// L'accueil commence par la question : décrire le besoin et lancer, sans quitter la page.
// Les pièces jointes, le persona et la reprise d'un dépôt restent sur « Nouveau projet ».
function saisieAccueil() {
  const choix = [["webapp", "Application web"], ["pwa", "Mobile"], ["site", "Site"], ["api", "Connecteur"]]
  const exemples = [["CRM léger", "Un CRM léger pour une équipe de 5 commerciaux : contacts, opportunités, relances."], ["Site d'architectes", "Le site vitrine d'un cabinet d'architectes, avec réalisations et formulaire de contact."], ["API ERP ↔ boutique", "Une API qui relie notre ERP à la boutique en ligne : stocks et commandes."], ["Suivi des congés", "Le suivi des congés de l'équipe : demandes, validation par le manager, calendrier."]]
  return html`<section class="accueil" aria-labelledby="accueil-titre">
    <form class="pile" data-form="nouveau" style="gap:12px">
      <h1 id="accueil-titre">Que veux-tu construire ?</h1>
      <div class="onglets-type" role="group" aria-label="Type de produit">${choix.map(([id, nom]) => html`<button type="button" class="filtre" data-action="brique" data-id="${id}" aria-pressed="${String(etat.brique === id)}">${nom}</button>`)}</div>
      <div class="saisie">
        <label class="cache" for="demande">La demande</label>
        <textarea id="demande" name="prompt" rows="3" required minlength="20" placeholder="Décris le besoin comme à un collègue : qui l'utilise, les écrans clés, ce qui n'est pas demandé."></textarea>
        <div class="saisie-bas"><a class="lien-btn" style="padding-left:0" href="#/nouveau">Pièces jointes, persona, dépôt existant…</a><button type="submit" class="btn btn-p btn-petit">Lancer l'analyse</button></div>
      </div>
      <div class="rangee" style="justify-content:center">${exemples.map(([nom, texte]) => html`<button type="button" class="pastille" data-action="exemple" data-texte="${texte}">${nom}</button>`)}</div>
    </form>
  </section>`
}

// Les types de produit, dits simplement (la clé reste celle de la brique).
const TYPES_PRODUIT = [
  ["webapp", "Une application à utiliser dans le navigateur : outil de gestion, tableau de bord, espace client."],
  ["pwa", "Une application qui s'installe sur le téléphone et marche même sans réseau."],
  ["site", "Des pages pour présenter une activité, trouvables sur Google, avec un formulaire de contact."],
  ["api", "Un connecteur qui relie deux logiciels entre eux, sans écran (pour un technicien)."],
]

function vueNouveau() {
  if (etat.depart === "depot") return vueReprendre()
  return html`
    ${barreHaut()}
    <div class="colonnes">
      <form class="colonne-large" data-form="nouveau" style="gap:22px">
        <div><a class="retour" href="#/">← Projets</a><h1 style="margin-top:8px">Que veux-tu construire ?</h1>
          <p class="chapeau">Explique-le comme à un collègue. L'usine te posera des questions si quelque chose n'est pas clair, puis te proposera un plan à valider.</p></div>
        ${choixDepart()}
        ${messageGlobal()}
        <div class="pile"><label class="titre-champ" for="demande">Ta demande</label>
          <textarea id="demande" name="prompt" class="champ" rows="8" required minlength="20" style="resize:vertical;line-height:1.6" placeholder="Ex. : une application pour nos techniciens. Chaque matin, ils voient leurs interventions du jour. Sur place, ils remplissent le compte rendu (photos, pièces changées, signature du client), même sans réseau. Le responsable suit tout depuis un tableau de bord."></textarea>
          <div class="aide">Trois choses aident beaucoup : qui va s'en servir, ce qu'ils doivent pouvoir faire, et ce dont tu n'as pas besoin.</div></div>
        <fieldset><legend>Quel genre d'outil ? <span class="aide" style="font-weight:400">· si tu hésites, laisse le premier : l'usine choisira</span></legend>
          <div class="briques">${TYPES_PRODUIT.map(([id, texte]) => html`<button type="button" class="brique" data-action="brique" data-id="${id}" aria-pressed="${String(etat.brique === id)}"><strong>${BRIQUES[id]}</strong><span>${texte}</span></button>`)}</div>
        </fieldset>
        ${champPersona()}
        <div class="pile">
          <label class="titre-champ" for="pieces">Des documents pour aider <span class="aide" style="font-weight:400">· facultatif : maquettes, captures d'écran, cahier des charges (3 fichiers, 2 Mo chacun)</span></label>
          <input id="pieces" type="file" accept="image/png,image/jpeg,image/webp,application/pdf,.md,.markdown,.txt,text/markdown,text/plain" multiple class="champ" style="padding:9px">
          ${etat.pieces.length ? html`<ul class="pieces">${etat.pieces.map((f, i) => html`<li><span>${f.name}</span><span class="aide">${Math.ceil(f.size / 1024)} Ko</span><button type="button" class="btn-icone" data-action="retirer-piece" data-id="${i}" aria-label="Retirer ${f.name}">✕</button></li>`)}</ul>` : ""}
          <div class="aide">Images, PDF ou texte. L'usine les lit avant de proposer son plan.</div>
        </div>
        <div class="rangee"><button type="submit" class="btn btn-p">Envoyer la demande</button><a href="#/" class="btn btn-s">Annuler</a></div>
      </form>
      <aside class="colonne-etroite" aria-label="Comment ça se passe">
        <div class="sombre pile">
          <div class="surtitre" style="color:inherit;opacity:.75">Comment ça se passe</div>
          <ol style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:14px">
            <li>L'usine lit ta demande et te pose ses questions s'il en faut.</li>
            <li>Elle te propose un plan : ce que tu pourras faire, étape par étape.</li>
            <li><strong>Tu valides le plan</strong>, ou tu demandes des changements.</li>
            <li>Elle construit et vérifie chaque fonction ; tu vois l'application grandir.</li>
            <li><strong>Tu essaies le résultat</strong> avant de le mettre en ligne.</li>
          </ol>
        </div>
        <div class="carte carte-p pile">
          <strong>Combien ça coûte ?</strong>
          ${etat.estimation?.disponible ? html`<div style="font-size:14px">Un projet habituel : environ <strong>${etat.estimation.cout}</strong> et <strong>${etat.estimation.duree}</strong> de travail de l'usine.</div>
            <div class="aide">Calculé sur les projets déjà faits. Le chiffre exact arrive avec le plan, avant que tu valides.</div>`
          : html`<div class="aide">${etat.estimation ? "L'usine n'a pas encore assez de projets derrière elle pour estimer à l'avance. Le coût prévu s'affichera avec le plan, avant que tu valides." : "Calcul…"}</div>`}
        </div>
        <div class="carte carte-p pile"><strong>Partir d'un exemple</strong>
          ${["Un outil pour suivre nos clients et nos relances : contacts, opportunités, rappels, pour une équipe de 5 commerciaux.", "Le site d'un cabinet d'architectes, avec ses réalisations et un formulaire de contact.", "Le suivi des congés de l'équipe : demandes, validation par le manager, calendrier commun.", "Un connecteur entre notre logiciel de gestion et la boutique en ligne : stocks et commandes."].map((x) => html`<button type="button" class="lien-btn" style="text-align:left;padding:4px 0" data-action="exemple" data-texte="${x}">${x}</button>`)}
        </div>
      </aside>
    </div>`
}

// --- Partir d'une application existante, et les publics (personas) ---------------------------
const STATUTS_PERSONA = { recherche: ["Recherche en cours", "bleu"], a_valider: ["À relire", "orange"], valide: ["Prêt", "vert"], echec: ["Recherche échouée", "rouge"] }
const badgePersona = (s) => html`<span class="badge ${(STATUTS_PERSONA[s] ?? ["", ""])[1]}">${(STATUTS_PERSONA[s] ?? [s])[0]}</span>`
const personasValides = () => (etat.personas ?? []).filter((p) => p.statut === "valide")

// Le choix du point de départ, en tête de « Nouveau projet ».
const choixDepart = () => html`<fieldset><legend class="cache">Point de départ</legend>
  <div class="briques">${[["zero", "Partir de zéro", "Tu décris l'outil, l'usine le construit."], ["depot", "Terminer une application existante", "Son code est sur GitHub : l'usine le reprend, l'adapte et le termine."]].map(([id, titre, texte]) => html`<button type="button" class="brique" data-action="depart" data-id="${id}" aria-pressed="${String(etat.depart === id)}"><strong>${titre}</strong><span>${texte}</span></button>`)}</div>
</fieldset>`

// Le choix du public (seuls ceux qui ont été relus).
function champPersona(obligatoire = false) {
  const liste = personasValides()
  return html`<div class="pile"><label class="titre-champ" for="persona">Pour qui ? <span class="aide" style="font-weight:400">· ${obligatoire ? "le public de l'application" : "facultatif"}</span></label>
    <select id="persona" name="persona_id" class="champ">
      <option value="">${liste.length ? "Pas de public précis" : "Aucun public décrit pour l'instant"}</option>
      ${liste.map((p) => html`<option value="${p.id}">${p.nom}</option>`)}
    </select>
    <div class="aide">Avec un public décrit, l'usine construit pour lui, puis essaie l'application à sa place avant de te la livrer. <a href="#/personas">Décrire un public</a>.</div></div>`
}

function vueReprendre() {
  return html`
    ${barreHaut()}
    <div class="colonnes">
      <form class="colonne-large" data-form="reprendre" style="gap:22px">
        <div><a class="retour" href="#/">← Projets</a><h1 style="margin-top:8px">Quelle application faut-il terminer ?</h1>
          <p class="chapeau">L'usine regarde d'abord ce qui marche et ce qui manque, puis te propose un plan pour la terminer et l'adapter à ton public.</p></div>
        ${choixDepart()}
        ${messageGlobal()}
        <div class="pile"><label class="titre-champ" for="adresse">L'adresse GitHub de l'application</label>
          <input id="adresse" name="adresse" class="champ mono" required placeholder="https://github.com/proprietaire/application" autocomplete="off" spellcheck="false">
          <div class="aide">Copie l'adresse de la page GitHub de l'application. Si elle est privée, son propriétaire doit d'abord inviter le compte GitHub de l'usine.</div></div>
        ${champPersona(true)}
        <div class="pile"><label class="titre-champ" for="consigne">Ce que tu veux en faire <span class="aide" style="font-weight:400">· facultatif</span></label>
          <textarea id="consigne" name="consigne" class="champ" rows="5" style="resize:vertical;line-height:1.6" placeholder="Ex. : garder l'analyse des mots-clés, ajouter le suivi des avis Google, pour un commerce de quartier."></textarea></div>
        <details class="carte carte-p"><summary style="cursor:pointer;font-weight:600">Où l'usine travaille <span class="aide" style="font-weight:400">· à laisser tel quel en cas de doute</span></summary>
          <fieldset class="pile" style="margin-top:12px"><legend class="cache">Où l'usine travaille</legend>
          ${[["auto", "Automatique (conseillé)", "L'usine choisit selon les droits qu'on lui a donnés."], ["direct", "Dans l'application d'origine", "Elle propose ses changements au propriétaire, qui les accepte lui-même à la fin. Rien n'est modifié sans lui."], ["copie", "Dans une copie", "Elle travaille sur une copie : l'original ne bouge pas."]].map(([id, titre, texte]) => html`<label class="choix"><input type="radio" name="mode" value="${id}" ${id === "auto" ? "checked" : ""}><span><strong>${titre}</strong><br><span class="aide">${texte}</span></span></label>`)}
          </fieldset></details>
        <div class="rangee"><button type="submit" class="btn btn-p">Lancer l'examen</button><a href="#/" class="btn btn-s">Annuler</a></div>
      </form>
      <aside class="colonne-etroite" aria-label="Comment ça se passe">
        <div class="sombre pile">
          <div class="surtitre" style="color:inherit;opacity:.75">Comment ça se passe</div>
          <ol style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:14px">
            <li>L'usine examine l'application : ce qui marche, ce qui est cassé, ce qui manque.</li>
            <li>Elle vérifie qu'elle démarre bien sur ses serveurs.</li>
            <li>Elle te propose un plan pour la terminer, pensé pour ton public.</li>
            <li><strong>Tu valides le plan.</strong></li>
            <li>Elle construit, puis essaie l'application à la place de ton public avant de te la livrer.</li>
          </ol>
        </div>
      </aside>
    </div>`
}

function vuePersonas() {
  const liste = etat.personas
  return html`
    ${barreHaut()}
    <div class="entete">
      <div><h1>Pour qui on construit</h1><p class="chapeau">Décris en quelques lignes les personnes qui utiliseront tes applications. L'usine fait une recherche sur le web pour mieux les connaître, puis tu relis sa fiche. On appelle ça un persona.</p></div>
    </div>
    ${messageGlobal()}
    <div class="colonnes">
      <section class="colonne-large carte" aria-labelledby="liste-personas">
        <div class="barre" style="padding:14px 16px;border-bottom:1px solid var(--trait)"><h2 id="liste-personas">Tes publics</h2></div>
        ${!liste ? html`<div class="chargement">Chargement…</div>` : liste.length ? html`<ul class="liste-publics">${liste.map((p) => html`<li>
            <a class="lien-projet" href="#/personas/${p.id}">${p.nom}</a> ${badgePersona(p.statut)}
            <div class="sous">${p.fiche?.resume ?? p.brief}</div>
            ${p.fiche ? html`<div class="sous">${p.fiche.sources?.length ?? 0} source(s) consultée(s) · ${p.scenarios?.length ?? 0} situation(s) de test</div>` : ""}
          </li>`)}</ul>`
        : html`<div class="vide">Aucun public pour l'instant : décris le premier à droite.</div>`}
      </section>
      <aside class="colonne-etroite pile">
        <form class="carte carte-p pile" data-form="persona-nouveau">
          <strong>Décrire un public</strong>
          <label class="titre-champ" for="persona-nom">Comment l'appeler ?</label>
          <input id="persona-nom" name="nom" class="champ" required maxlength="80" placeholder="Ex. : Commerçant de quartier">
          <label class="titre-champ" for="persona-brief">Qui est-ce ?</label>
          <textarea id="persona-brief" name="brief" class="champ" rows="6" required minlength="15" style="resize:vertical;line-height:1.6" placeholder="Ex. : une boulangerie de quartier à Lyon, sans site web, avec des avis Google. Le gérant veut être trouvé par les gens du coin, mais n'a pas le temps de s'en occuper."></textarea>
          <div><button type="submit" class="btn btn-p">Lancer la recherche</button></div>
          <div class="aide">L'usine cherche sur le web (études, forums, avis) et revient avec une fiche et ses sources. Comptez quelques minutes.</div>
        </form>
        <div class="sombre pile"><div class="surtitre" style="color:inherit;opacity:.75">Les situations de test</div>
          <div style="font-size:14px">La fiche contient 3 à 5 situations réelles (« Demander un devis depuis son téléphone »). À la fin de chaque projet, l'usine les joue à la place de ton public pour juger l'application. Celui qui construit ne les voit jamais : il ne peut pas tricher.</div></div>
      </aside>
    </div>`
}

const lignes = (l) => (l ?? []).join("\n")
function vuePersona() {
  const p = etat.persona
  if (!p || p.id !== etat.route.id) return html`${barreHaut()}<div class="chargement">Chargement…</div>`
  const f = p.fiche ?? {}
  const scenarios = etat.personaScenarios ?? p.scenarios ?? []
  const zone = (nom, titre, valeur, aide, rangs = 3) => html`<div class="pile"><label class="titre-champ" for="pf-${nom}">${titre}</label><textarea id="pf-${nom}" name="${nom}" class="champ" rows="${rangs}" style="resize:vertical;line-height:1.5">${valeur}</textarea>${aide ? html`<div class="aide">${aide}</div>` : ""}</div>`
  return html`
    ${barreHaut()}
    <div class="entete">
      <div><a class="retour" href="#/personas">← Pour qui on construit</a>
        <div class="rangee" style="margin-top:8px;gap:12px"><h1>${p.nom}</h1>${badgePersona(p.statut)}</div>
        <p class="chapeau">${p.brief}</p></div>
    </div>
    ${messageGlobal()}
    ${p.statut === "recherche" ? html`<div class="message info"><span>L'usine fait sa recherche sur le web. Cette page se met à jour toute seule, en quelques minutes (un peu plus si l'usine est en train de construire).</span></div>` : ""}
    ${p.statut === "echec" ? html`<div class="message erreur"><span style="flex:1">La recherche n'a pas abouti : ${p.erreur ?? "raison inconnue"}</span><button type="button" class="btn btn-s btn-petit" data-action="persona-approfondir">Relancer la recherche</button></div>` : ""}
    ${p.statut === "a_valider" ? html`<div class="message info"><span style="flex:1"><strong>La fiche est prête : relis-la.</strong> Corrige ce qui ne va pas, puis clique sur « C'est bon, utiliser ce public ».</span><button type="button" class="btn btn-p btn-petit" data-action="persona-valider">C'est bon, utiliser ce public</button></div>` : ""}
    ${p.fiche ? html`<div class="colonnes">
      <form class="colonne-large pile" data-form="persona" style="gap:18px">
        <section class="carte carte-p pile"><h2>Qui il est</h2>
          <div class="pile"><label class="titre-champ" for="pf-nom">Nom</label><input id="pf-nom" name="nom" class="champ" value="${p.nom}" maxlength="80"></div>
          ${zone("resume", "En deux phrases", f.resume, "Qui il est, ce qu'il cherche à obtenir.", 3)}
          ${zone("demographie", "Son profil", lignes(f.demographie), "Une information par ligne (âge, métier, taille de l'entreprise…).")}
          ${zone("psychographie", "Ce qui le motive, ce qui l'inquiète", lignes(f.psychographie), "Une idée par ligne.")}
        </section>
        <section class="carte carte-p pile"><h2>Ce qu'il vit</h2>
          ${zone("problemes", "Ses problèmes", lignes((f.problemes ?? []).map((x) => [x.probleme, x.preuve, x.source].filter(Boolean).join(" | "))), "Un problème par ligne. La preuve et la source trouvées par l'usine suivent, séparées par « | » : tu peux les laisser telles quelles.", 6)}
          ${zone("besoins", "Ses besoins", lignes(f.besoins), "Un par ligne.", 4)}
          ${zone("outils_actuels", "Ce qu'il utilise aujourd'hui", lignes(f.outils_actuels), "Un outil par ligne.")}
          <div class="pile"><label class="titre-champ" for="pf-prix">Ce qu'il est prêt à payer</label><input id="pf-prix" name="prix_acceptable" class="champ" value="${f.prix_acceptable ?? ""}"></div>
          ${zone("objections", "Ce qui le ferait renoncer", lignes(f.objections), "Une raison par ligne.")}
          ${zone("canaux", "Où le trouver", lignes(f.canaux), "Un endroit par ligne.")}
        </section>
        <section class="carte carte-p pile"><h2>Ce qu'on ne construit pas pour lui</h2>
          ${zone("hors_perimetre", "Hors sujet", lignes(p.hors_perimetre), "Une chose par ligne. L'usine s'en tiendra à l'écart dans chaque projet pour ce public.", 4)}
        </section>
        <section class="carte carte-p pile"><h2>Les situations de test · ${scenarios.length}</h2>
          <div class="aide">De 3 à 5 situations réelles. L'usine les joue à la fin de chaque projet, à la place de ce public. Celui qui construit ne les voit jamais.</div>
          ${scenarios.map((s, i) => html`<fieldset class="carte carte-p pile" data-scenario="${i}" style="background:var(--fond)">
            <div class="rangee" style="justify-content:space-between"><strong>Situation ${i + 1}</strong><button type="button" class="btn btn-s btn-petit" data-action="persona-retirer-scenario" data-id="${i}">Retirer</button></div>
            <label class="titre-champ" for="ps-titre-${i}">En une phrase</label><input id="ps-titre-${i}" class="champ" data-champ="titre" value="${s.titre}">
            <label class="titre-champ" for="ps-situation-${i}">Le contexte</label><textarea id="ps-situation-${i}" class="champ" data-champ="situation" rows="2">${s.situation}</textarea>
            <label class="titre-champ" for="ps-etapes-${i}">Ce qu'il fait <span class="aide" style="font-weight:400">· une action par ligne</span></label><textarea id="ps-etapes-${i}" class="champ" data-champ="etapes" rows="3">${lignes(s.etapes)}</textarea>
            <label class="titre-champ" for="ps-attendu-${i}">Ce qu'il doit obtenir</label><textarea id="ps-attendu-${i}" class="champ" data-champ="attendu" rows="2">${s.attendu}</textarea>
          </fieldset>`)}
          ${scenarios.length < 5 ? html`<div><button type="button" class="btn btn-s btn-petit" data-action="persona-ajouter-scenario">+ Ajouter une situation</button></div>` : ""}
        </section>
        <section class="carte carte-p pile"><h2>Les sources consultées</h2>
          ${zone("sources", "Sources", lignes((f.sources ?? []).map((s) => (s.titre ? `${s.titre} | ${s.url}` : s.url))), "Une par ligne : titre | adresse.", 4)}
        </section>
        <div class="rangee"><button type="submit" class="btn btn-p">Enregistrer</button>${p.statut === "a_valider" ? html`<button type="button" class="btn btn-s" data-action="persona-valider">C'est bon, utiliser ce public</button>` : ""}</div>
      </form>
      <aside class="colonne-etroite pile">
        ${p.statut === "valide" ? html`<div class="message ok"><span>Prêt${p.valide_par ? `, relu par ${p.valide_par}` : ""} : il se choisit dans « Pour qui ? » en créant un projet. Si tu modifies la fiche, il faudra la relire.</span></div>` : ""}
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
      <a class="btn btn-voile" href="#/acces">Inviter des utilisateurs</a>
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

function vueSante() {
  const s = etat.sante
  if (!s) return html`${barreHaut()}<div class="chargement">Vérification de l'usine…</div>`
  const max = Math.max(1e-9, ...s.couts.evolution.map((e) => Math.max(e.api, e.reel)))
  const mj = s.serveur?.mise_a_jour
  const soucis = s.composants.filter((c) => c.etat !== "ok")
  const pannes = soucis.filter((c) => c.etat === "panne")
  return html`
    ${barreHaut()}
    <div class="entete"><div><h1>État et dépenses</h1><p class="chapeau">L'usine se vérifie elle-même chaque minute.</p></div>
      ${mj?.disponible ? html`<div class="carte rangee" style="padding:10px 14px;gap:12px"><span><strong>Une nouvelle version est disponible</strong></span><button type="button" class="btn btn-p" data-action="usine" data-quoi="mettre-a-jour">Mettre à jour l'usine</button></div>` : ""}</div>
    ${messageGlobal()}
    <section class="carte carte-p pile etat-general ${pannes.length ? "panne" : soucis.length ? "alerte" : "ok"}" aria-labelledby="etat-general">
      <h2 id="etat-general">${pannes.length ? `${pannes.length === 1 ? "Un service est en panne" : `${pannes.length} services sont en panne`}` : soucis.length ? `${soucis.length === 1 ? "Un point demande ton attention" : `${soucis.length} points demandent ton attention`}` : "Tout fonctionne"}</h2>
      ${soucis.length ? html`<ul class="soucis">${soucis.map((c) => html`<li><span class="point ${c.etat}" aria-hidden="true"></span><span><strong>${nomService(c.nom)}</strong> : ${c.detail}</span></li>`)}</ul>
        <div class="aide">Si une panne dure, préviens la personne qui s'occupe du serveur.</div>`
      : html`<div class="aide">${s.composants.length} services vérifiés.</div>`}
      <details><summary class="aide" style="cursor:pointer">Voir tous les services</summary>
        <div class="grille" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;margin-top:10px">${s.composants.map((c) => html`<div class="carte" style="padding:12px 14px;display:flex;gap:10px;align-items:flex-start" title="${c.nom}">
          <span class="point ${c.etat === "ok" ? "" : c.etat}" style="margin-top:7px" aria-hidden="true"></span>
          <span style="min-width:0"><strong style="font-size:14px">${nomService(c.nom)}</strong><br><span class="aide">${c.detail}</span></span></div>`)}</div>
      </details>
    </section>
    <section class="carte carte-p pile" style="gap:16px" aria-labelledby="couts">
      <div class="barre"><h2 id="couts">Les dépenses du mois</h2><a class="aide" href="/couts">Détail complet</a></div>
      <div class="grille">
        <div><div class="aide">Ce que l'IA aurait coûté au prix public</div><div style="font-size:26px;font-weight:700">${s.couts.api}</div><div class="aide">C'est sur ce chiffre que portent les budgets.</div></div>
        <div><div class="aide">Ce que tu paies vraiment</div><div style="font-size:26px;font-weight:700">${s.couts.reel}</div><div class="aide">Abonnements et serveur : souvent bien moins.</div></div>
        <div><div class="aide">Budget du mois${s.couts.budget ? ` · ${s.couts.budget}` : ""}</div>
          ${s.couts.pct !== null ? html`<div class="jauge bleue" style="height:12px;margin-top:10px"><div style="width:${Math.min(100, s.couts.pct)}%"></div></div><div class="aide" style="margin-top:6px">${s.couts.pct} % utilisés. L'usine te prévient en approchant de la limite.</div>` : html`<div style="font-size:18px;font-weight:600">pas de limite</div><div class="aide"><a href="#/reglages">Fixer un budget</a></div>`}</div>
      </div>
      <div class="graph" aria-label="Dépenses des six derniers mois">${s.couts.evolution.map((e) => html`<div title="${e.mois} : ${e.api_texte} au prix public, ${e.reel_texte} payés"><i style="height:${Math.round((e.api / max) * 100)}%"></i><i class="reel" style="height:${Math.round((e.reel / max) * 100)}%"></i></div>`)}</div>
      <div class="graph-legende">${s.couts.evolution.map((e) => html`<span>${e.mois.slice(5)}/${e.mois.slice(2, 4)}</span>`)}</div>
      <div class="rangee aide"><span><span class="badge bleu">■</span> au prix public</span><span><span class="badge vert">■</span> payé</span></div>
      <div class="tableau"><table style="min-width:520px"><thead><tr><th>Projet</th><th>Au prix public</th><th>Payé</th><th>Budget du projet</th><th title="Versions refusées par le contrôle qualité, puis refaites">Versions refaites</th></tr></thead>
        <tbody>${s.couts.projets.map((p) => html`<tr><td><a class="lien-projet" href="#/projets/${p.id}">${p.nom}</a></td><td class="mono">${p.mesure ? p.api : "pas encore mesuré"}</td><td class="mono">${p.mesure ? p.reel : "—"}</td><td>${p.budget_pct !== null ? html`<span class="${p.budget_pct >= 80 ? "badge orange" : "aide"}">${p.budget_pct} % utilisés</span>` : "—"}</td><td>${p.refus}</td></tr>`)}</tbody></table></div>
    </section>
    <section class="carte carte-p pile"><h2>Mettre l'usine en pause</h2>
      <div class="aide">L'usine termine ce qu'elle est en train de faire, puis s'arrête. Rien n'est perdu : elle reprend où elle en était.</div>
      <div class="rangee"><button type="button" class="btn btn-s" data-action="usine" data-quoi="stop">Mettre en pause</button><button type="button" class="btn btn-s" data-action="usine" data-quoi="reprendre">Reprendre</button></div></section>`
}

function vueAcces() {
  const a = etat.acces
  if (!a) return html`${barreHaut()}<div class="chargement">Chargement des accès…</div>`
  const slugs = Object.entries(a.noms)
  // Des cases à cocher plutôt qu'une liste à sélection multiple (Ctrl + clic).
  const cases = (nom, id) => html`<div class="pile" style="gap:6px" role="group" aria-labelledby="${id}">
    <label class="coche"><input type="checkbox" name="${nom}" value="*"><span>Toutes les applications</span></label>
    ${slugs.map(([slug, n]) => html`<label class="coche"><input type="checkbox" name="${nom}" value="${slug}"><span>${n ?? slug}</span></label>`)}</div>`
  const decrire = (u) => (u.role === "admin" ? "tout, y compris cette console" : u.applis.includes("*") ? "toutes les applications" : u.applis.map((s) => a.noms[s] ?? s).join(", ") || "aucune application")
  return html`
    ${barreHaut()}
    <div><h1>Qui a accès</h1><p class="chapeau">Chaque application est protégée par une page de connexion. On y entre sur invitation : la personne reçoit un lien et choisit son mot de passe.</p></div>
    ${messageGlobal()}
    <section class="carte" aria-labelledby="personnes">
      <div class="barre" style="padding:14px 16px;border-bottom:1px solid var(--trait)"><h2 id="personnes">Les personnes</h2></div>
      <div class="tableau"><table style="min-width:600px"><thead><tr><th>Personne</th><th>Peut ouvrir</th><th>État</th><th><span class="cache">Actions</span></th></tr></thead>
        <tbody>${a.utilisateurs.map((u) => html`<tr><td><strong>${u.email}</strong><div class="sous">${u.nom ? `${u.nom} · ` : ""}${u.role === "admin" ? "Administrateur" : "Membre"}</div></td><td>${decrire(u)}</td>
          <td>${u.active ? html`<span class="badge vert">a accepté</span>` : html`<span class="badge orange">invitation envoyée</span>`}</td>
          <td style="text-align:right;white-space:nowrap">${u.active ? "" : html`<button type="button" class="btn btn-s btn-petit" data-action="renvoyer" data-id="${u.id}">Renvoyer l'invitation</button> `}${etat.confirmer === `retirer-${u.id}` ? html`<button type="button" class="btn btn-d btn-petit" data-action="retirer-personne" data-id="${u.id}">Oui, retirer</button> <button type="button" class="btn btn-s btn-petit" data-action="annuler">Annuler</button>` : html`<button type="button" class="btn btn-s btn-petit" data-action="confirmer" data-quoi="retirer-${u.id}">Retirer l'accès</button>`}</td></tr>`)}</tbody></table></div>
      ${etat.invitation ? html`<div class="message info" style="margin:16px">${etat.invitation}</div>` : ""}
      <form class="pile" style="padding:16px;border-top:1px solid var(--trait-2);gap:14px" data-form="inviter">
        <strong>Inviter quelqu'un</strong>
        <div class="grille">
          <div class="pile" style="gap:6px"><label class="aide" for="inv-email">Son adresse email</label><input id="inv-email" name="email" type="email" class="champ" required></div>
          <fieldset class="pile" style="gap:6px"><legend class="aide">Ce qu'il pourra faire</legend>
            <label class="choix"><input type="radio" name="role" value="membre" checked><span><strong>Essayer des applications</strong><br><span class="aide">celles que tu coches ci-dessous</span></span></label>
            <label class="choix"><input type="radio" name="role" value="admin"><span><strong>Piloter l'usine avec toi</strong><br><span class="aide">administrateur : accès à tout, y compris cette console</span></span></label></fieldset>
          <div class="pile" style="gap:6px"><div class="aide" id="inv-applis">Les applications qu'il pourra ouvrir</div>${cases("applis", "inv-applis")}</div>
        </div>
        <div><button type="submit" class="btn btn-p">Envoyer l'invitation</button></div>
      </form>
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
            <div class="pile" style="gap:6px"><div class="aide" id="cle-applis">Les applications qu'elle ouvre</div>${cases("applis", "cle-applis")}</div>
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

function blocFournisseurs() {
  const f = etat.fournisseurs
  if (!f) return html`<section class="carte carte-p"><div class="chargement">Chargement…</div></section>`
  const modeles = f.modeles
  return html`<section class="carte carte-p pile" style="gap:16px" aria-labelledby="fournisseurs">
    <div class="barre" style="flex-wrap:wrap;gap:10px">
      <div><h2 id="fournisseurs">L'intelligence artificielle</h2><p class="aide" style="margin:4px 0 0">L'usine travaille avec deux IA : l'une construit, l'autre contrôle. Ce que tu colles ici est chiffré et ne s'affiche plus jamais.</p>
        ${f.protection === "axmaril" ? html`<p style="margin:8px 0 0"><span class="badge vert">clés scellées</span> <span class="aide">Même une copie du serveur ne permettrait pas de les lire.</span></p>` : ""}</div>
      <div class="pile" style="gap:4px;align-items:flex-end"><button type="button" class="btn btn-p" data-action="tester-fournisseurs">Tester les connexions</button><span class="aide">${f.tests.le ? `Dernier test : ${dateCourte(f.tests.le)}` : "Jamais testé"}</span></div>
    </div>
    ${f.verrouille ? html`<div class="message erreur">Les clés enregistrées ici sont verrouillées pour l'instant : l'usine utilise celles du serveur. Préviens la personne qui s'occupe du serveur.</div>` : ""}
    <div class="grille">${f.moteurs.map((m) => carteMoteur(f, m))}</div>
    <details class="carte carte-p"><summary style="cursor:pointer;font-weight:600">Réglages avancés : passerelle de secours et modèles</summary>
      <div class="pile" style="gap:16px;margin-top:12px">
        <div class="pile" style="gap:10px">
          <div class="aide">La passerelle Vercel AI Gateway donne accès aux deux IA avec une seule clé : elle sert de secours commun. Sur <span class="mono">vercel.com</span>, AI Gateway, API Keys.</div>
          ${champIdentifiant(f, "AI_GATEWAY_API_KEY", "", "Clé de la passerelle Vercel")}
        </div>
        <form class="pile" style="gap:12px" data-form="modeles">
          <div><strong>Quel modèle pour quel rôle</strong><div class="aide">Laisse vide pour garder le choix par défaut.</div></div>
          <datalist id="modeles-connus">${MODELES_CONNUS.map((x) => html`<option value="${x}"></option>`)}</datalist>
          <div class="grille">${modeles.map((m) => html`<div class="pile" style="gap:6px"><label class="aide" for="mod-${m.role}">${ROLES_MODELES[m.role] ?? m.role}</label><input id="mod-${m.role}" name="${m.role}" class="champ mono" list="modeles-connus" value="${m.modele !== m.contrat ? m.modele : ""}" placeholder="${m.contrat ?? m.modele}" autocomplete="off" spellcheck="false"></div>`)}</div>
          <div><button type="submit" class="btn btn-s">Enregistrer les modèles</button></div>
        </form>
      </div>
    </details>
  </section>`
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

function vueReglages() {
  const r = etat.reglages
  if (!r) return html`${barreHaut()}<div class="chargement">Chargement des réglages…</div>`
  const f = r.forge
  const c = r.couts
  const k = r.contrat
  return html`
    ${barreHaut()}
    <div class="entete"><div><h1>Réglages</h1><p class="chapeau">Brancher l'IA et GitHub, fixer les budgets. Le reste est déjà réglé.</p></div>
      <a class="btn btn-s" href="#/demarrer">Revoir les premiers pas</a></div>
    ${messageGlobal()}
    ${blocFournisseurs()}
    <section class="carte carte-p pile" aria-labelledby="forge" style="gap:16px">
      <div><h2 id="forge">Où le code est rangé</h2><p class="aide" style="margin:4px 0 0">Chaque application a son espace sur GitHub, où l'usine range son code et l'historique de ce qu'elle a fait. Tu peux y jeter un œil, mais tu n'en as pas besoin au quotidien.</p></div>
      ${carteGithub(f)}
    </section>
    <form class="carte carte-p pile" style="gap:16px" data-form="couts" aria-labelledby="budgets">
      <div><h2 id="budgets">Budgets</h2><p class="aide" style="margin:4px 0 0">Ce que l'usine peut dépenser en IA, calculé au prix public. Elle te prévient en approchant de la limite (${c.alertes.join(", ")} %), puis te demande avant de continuer. Mets 0 pour ne pas fixer de limite.</p></div>
      <div class="grille">
        <div class="pile" style="gap:6px"><label class="aide" for="b-mensuel">Par mois, pour toute l'usine (${c.devise})</label><input id="b-mensuel" name="budget_mensuel" class="champ" inputmode="decimal" value="${c.budget_mensuel}"></div>
        <div class="pile" style="gap:6px"><label class="aide" for="b-projet">Par projet (${c.devise})</label><input id="b-projet" name="budget_par_projet" class="champ" inputmode="decimal" value="${c.budget_par_projet}"></div>
      </div>
      <details><summary class="aide" style="cursor:pointer">Ce que tu paies chaque mois (pour calculer le coût réel)</summary>
        <div class="grille" style="margin-top:10px">
          <div class="pile" style="gap:6px"><label class="aide" for="b-serveur">Le serveur (${c.devise})</label><input id="b-serveur" name="serveur_mensuel" class="champ" inputmode="decimal" value="${c.serveur_mensuel}"></div>
          ${c.abonnements.map((a, i) => html`<div class="pile" style="gap:6px"><label class="aide" for="b-ab-${i}">${a.nom} (${c.devise})</label><input id="b-ab-${i}" name="abonnement" class="champ" inputmode="decimal" value="${a.mensuel}"></div>`)}
        </div></details>
      <div><button type="submit" class="btn btn-p">Enregistrer</button></div>
    </form>
    <section class="carte carte-p pile" style="gap:10px" aria-labelledby="slack">
      <div class="barre"><h2 id="slack">Slack <span class="aide">(facultatif)</span></h2>${r.slack?.branche ? html`<span class="badge vert">branché</span>` : html`<span class="badge">pas branché</span>`}</div>
      <p class="aide" style="margin:0">Tout se fait ici. Slack ajoute seulement des notifications et des boutons dans un canal de ton équipe${r.slack?.branche && r.slack.canal ? ` (ici : ${r.slack.canal})` : ""}. Pour le brancher, demande à la personne qui s'occupe du serveur.</p>
    </section>
    <details class="carte carte-p" aria-labelledby="contrat">
      <summary style="cursor:pointer;font-weight:600" id="contrat">Les règles de l'usine</summary>
      <div class="pile" style="gap:16px;margin-top:12px">
        <p class="aide" style="margin:0">Ces règles sont appliquées par l'usine elle-même. Elles se changent sur le serveur, par un technicien.</p>
        <div class="pile" style="gap:8px"><strong>Qui décide</strong>
          ${Object.entries(k.politiques).map(([a, v]) => html`<div class="barre" style="font-size:14px"><span>${ACTIONS_POLITIQUES[a] ?? a}</span><span class="badge ${v === "manuel" ? "orange" : v === "jamais" ? "rouge" : "vert"}">${POLITIQUES[v] ?? v}</span></div>`)}</div>
        <div class="grille" style="font-size:14px">
          <div><div class="aide">Quand une fonction est refusée</div>l'usine la refait <strong>${k.autonomie.tentatives_par_tache ?? 2} fois</strong>, puis essaie <strong>${k.autonomie.changements_d_approche ?? 1} autre méthode</strong> avant de te demander</div>
          <div><div class="aide">Temps maximum pour une fonction</div><strong>${k.autonomie.minutes_max_par_agent ?? 30} minutes</strong></div>
          <div><div class="aide">Aperçus</div>retirés après <strong>${k.apercus_jours} jours</strong> sans activité (tu es prévenu la veille)</div>
          <div><div class="aide">Mode démonstration</div><strong>${k.demo ? "actif" : "inactif"}</strong> : données fictives, emails retenus${k.finition ? ", lot de finition" : ""}</div>
        </div>
        <details><summary class="aide" style="cursor:pointer">Pour les techniciens</summary>
          <div class="pile" style="gap:8px;margin-top:8px">
            <div class="tableau"><table><tbody>${k.modeles.map((m) => html`<tr><td>${ROLES[m.role] ?? m.role}</td><td class="mono">${m.modele}</td><td class="aide">${m.moteur}</td></tr>`)}</tbody></table></div>
            <div class="aide">Fichier : <span class="mono">usine.config.yml</span> · fichiers protégés des produits : <span class="mono">${k.perimetre_protege.join(" · ")}</span></div>
          </div></details>
      </div>
    </details>`
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
function vueHistorique() {
  const h = etat.historique
  const projets = etat.resume?.projets ?? []
  return html`
    ${barreHaut()}
    <div><h1>Historique</h1><p class="chapeau">Qui a fait quoi, et quand : demandes, validations, décisions, mises en ligne, réglages. Les 200 derniers évènements.</p></div>
    <div class="rangee">
      <label class="aide" for="h-projet">Projet</label>
      <select id="h-projet" class="champ" style="width:auto" data-filtre-histo="projet"><option value="">Tous</option>${projets.map((p) => html`<option value="${p.id}" ${String(p.id) === etat.histoFiltre.projet ? "selected" : ""}>${p.nom}</option>`)}</select>
      <label class="aide" for="h-type">Type</label>
      <select id="h-type" class="champ" style="width:auto" data-filtre-histo="type"><option value="">Tous</option>${Object.entries(TYPES_HISTO).map(([k, v]) => html`<option value="${k}" ${k === etat.histoFiltre.type ? "selected" : ""}>${v}</option>`)}</select>
    </div>
    <section class="carte" aria-label="Évènements">
      ${!h ? html`<div class="chargement">Chargement…</div>` : h.length ? html`<div class="tableau"><table style="min-width:700px"><thead><tr><th>Quand</th><th>Projet</th><th>Quoi</th><th>Qui</th></tr></thead>
        <tbody>${h.map((x) => html`<tr><td style="white-space:nowrap">${heure(x.le)}</td><td>${x.projet_id ? html`<a class="lien-projet" href="#/projets/${x.projet_id}">${x.projet ?? `Projet ${x.projet_id}`}</a>` : html`<span class="aide">l'usine</span>`}</td>
          <td><span class="badge ${["erreur", "escalade"].includes(x.type) ? "orange" : x.type === "production" || x.type === "validation" ? "vert" : ""}">${TYPES_HISTO[x.type] ?? x.type}</span>
            <div style="white-space:pre-wrap;word-break:break-word;margin-top:4px">${nettoyer(x.message.length > 280 ? x.message.slice(0, 280) + "…" : x.message)}</div></td>
          <td>${x.par ?? html`<span class="aide">l'usine</span>`}</td></tr>`)}</tbody></table></div>`
      : html`<div class="vide">Rien pour ce choix.</div>`}
    </section>`
}

// --- Rendu et chargement ------------------------------------------------------------------
function rendre() {
  const vue = { projets: vueProjets, nouveau: vueNouveau, projet: vueProjet, sante: vueSante, acces: vueAcces, reglages: vueReglages, historique: vueHistorique, personas: vuePersonas, persona: vuePersona, demarrer: vueDemarrer }[etat.route.vue]
  const m = $("#principal")
  // Garder le défilement du journal s'il était en bas.
  const j = $("#journal")
  const enBas = !j || j.scrollTop + j.clientHeight >= j.scrollHeight - 20
  const a = document.activeElement
  const cleFocus = a && m.contains(a) && a !== m ? ["action", "id", "quoi", "choix", "hote"].map((k) => a.dataset?.[k] ?? "").join("|") + "|" + (a.id ?? "") : null
  $("#vue").innerHTML = vue()[BRUT]
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
  for (const a of document.querySelectorAll(".nav a")) {
    const actif = a.dataset.nav === ({ projet: "projets", persona: "personas" }[etat.route.vue] ?? etat.route.vue)
    if (actif) a.setAttribute("aria-current", "page")
    else a.removeAttribute("aria-current")
  }
  const r = etat.resume
  if (r) {
    $("#base").textContent = r.usine.base
    $("#cote-bas").innerHTML = html`${r.usine.mise_a_jour?.disponible ? html`<a href="#/sante" class="carte" style="display:block;padding:12px;color:var(--encre);text-decoration:none"><strong style="display:block">Mise à jour disponible</strong><span class="aide">${r.usine.mise_a_jour.disponible} changement(s)</span></a>` : ""}
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
    if (r.vue === "nouveau" && !etat.estimation) taches.push(api("GET", "estimation").then((x) => { etat.estimation = x; rendre() }))
    if (["nouveau", "personas", "projet"].includes(r.vue)) taches.push(api("GET", "personas").then((x) => { if (frais()) { etat.personas = x.personas; rendre() } }))
    if (r.vue === "persona") taches.push(api("GET", `personas/${r.id}`).then((x) => { if (frais()) { etat.persona = x; rendre() } }))
    if (r.vue === "historique") taches.push(api("GET", `historique?projet=${encodeURIComponent(etat.histoFiltre.projet)}&type=${encodeURIComponent(etat.histoFiltre.type)}`).then((x) => { if (frais()) { etat.historique = x; rendre() } }))
    if (r.vue === "projet") taches.push(api("GET", `projets/${r.id}`).then((x) => {
      if (!frais()) return
      etat.projet = x
      rendre()
    }))
    if (r.vue === "sante") taches.push(api("GET", "sante").then((x) => { etat.sante = x; rendre() }))
    if (r.vue === "acces") taches.push(api("GET", "acces").then((x) => { etat.acces = x; rendre() }))
    if (r.vue === "reglages") taches.push(api("GET", "reglages").then((x) => { etat.reglages = x; rendre() }))
    if (["projets", "demarrer", "reglages"].includes(r.vue)) taches.push(api("GET", "premiers-pas").then((x) => {
      if (!frais()) return
      etat.premiersPas = x
      // Une usine neuve s'ouvre sur ses premiers pas.
      if (r.vue === "projets" && !location.hash && !x.termine && !x.masque && !etat.premiersPasVus) { etat.premiersPasVus = true; location.hash = "#/demarrer"; return }
      rendre()
    }))
    if (r.vue === "reglages") taches.push(api("GET", "fournisseurs").then((x) => { etat.fournisseurs = x; rendre() }))
    await Promise.all(taches)
  } catch (e) {
    if (!silencieux) etat.message = { type: "erreur", texte: e.message }
  }
  rendre()
}

// Pendant une saisie, on ne redessine pas (on perdrait le texte ou le curseur).
function enSaisie() {
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

// La fiche d'un persona, lue dans son formulaire (une liste = une entrée par ligne).
function lireFichePersona(f) {
  const d = new FormData(f)
  const liste = (nom) => String(d.get(nom) ?? "").split("\n").map((x) => x.trim()).filter(Boolean)
  const parties = (l) => l.split("|").map((x) => x.trim())
  return {
    nom: String(d.get("nom") ?? "").trim(),
    fiche: {
      resume: String(d.get("resume") ?? "").trim(),
      problemes: liste("problemes").map((l) => { const [probleme, preuve = "", source = ""] = parties(l); return { probleme, preuve, source } }),
      besoins: liste("besoins"), demographie: liste("demographie"), psychographie: liste("psychographie"), outils_actuels: liste("outils_actuels"),
      prix_acceptable: String(d.get("prix_acceptable") ?? "").trim(), objections: liste("objections"), canaux: liste("canaux"),
      sources: liste("sources").map((l) => { const p = parties(l); return p.length > 1 ? { titre: p[0], url: p.slice(1).join("|") } : { titre: "", url: p[0] } }),
    },
    hors_perimetre: liste("hors_perimetre"),
    scenarios: [...f.querySelectorAll("[data-scenario]")].map((s) => {
      const v = (champ) => s.querySelector(`[data-champ=${champ}]`)?.value.trim() ?? ""
      return { titre: v("titre"), situation: v("situation"), etapes: v("etapes").split("\n").map((x) => x.trim()).filter(Boolean), attendu: v("attendu") }
    }),
  }
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
  depart: (el) => { etat.depart = el.dataset.id; rendre() },
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
    etat.personaScenarios = lireFichePersona($("[data-form=persona]")).scenarios.concat([{ titre: "", situation: "", etapes: [], attendu: "" }])
    rendre()
  },
  "persona-retirer-scenario": (el) => {
    etat.personaScenarios = lireFichePersona($("[data-form=persona]")).scenarios.filter((_, i) => i !== Number(el.dataset.id))
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
    const r = await agir(() => api("POST", "personas", { nom: d.get("nom"), brief: d.get("brief") }), { succes: "Recherche lancée : la fiche arrive dans quelques minutes." })
    if (r?.id) location.hash = `#/personas/${r.id}`
  }
  if (type === "persona") {
    const r = await agir(() => api("PUT", `personas/${etat.persona.id}`, lireFichePersona(f)))
    if (r) etat.personaScenarios = null
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
    const r = await agir(() => api("POST", "acces/utilisateurs", { email: d.get("email"), role: d.get("role"), applis: d.getAll("applis") }), { succes: "Invitation créée." })
    etat.invitation = r ? (r.envoye ? `Invitation envoyée par email à ${d.get("email")} (lien valable 72 h).` : `L'email n'est pas parti : transmets ce lien toi-même (personnel, 72 h) : ${r.lien}`) : null
    rendre()
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
    await agir(() => api("PUT", "reglages/couts", { budget_mensuel: d.get("budget_mensuel"), budget_par_projet: d.get("budget_par_projet"), serveur_mensuel: d.get("serveur_mensuel"), abonnements: d.getAll("abonnement") }))
  }
  if (type === "cle") {
    const r = await agir(() => api("POST", "acces/cles", { nom: d.get("nom"), applis: d.getAll("applis") }), { succes: "Clé créée." })
    if (r?.cle) { etat.cleCreee = r.cle; rendre() }
  }
})

document.addEventListener("keydown", (e) => {
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
    { texte: "État et dépenses", aide: "page", aller: "#/sante" },
    { texte: "Qui a accès : inviter quelqu'un", aide: "page", aller: "#/acces" },
    { texte: "Pour qui on construit (publics)", aide: "page", aller: "#/personas" },
    { texte: "Réglages : IA, GitHub, budgets", aide: "page", aller: "#/reglages" },
    { texte: "Historique : qui a fait quoi", aide: "page", aller: "#/historique" },
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
  etat.message = null
  etat.confirmer = null
  etat.planModifie = false
  etat.planEdition = null
  etat.cleCreee = null
  etat.invitation = null
  etat.personaScenarios = null
  // Chaque projet s'ouvre sur le plan en lecture, les réglages de mise en ligne repliés.
  etat.planVue = "lecture"
  etat.prodReglages = false
  etat.reorienterOuvert = false
  if (etat.route.vue !== "projet") etat.onglet = null
  etat.direct = null
  rendre()
  charger()
  window.scrollTo(0, 0)
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
