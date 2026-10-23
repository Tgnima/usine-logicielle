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
  creation: ["Création", "bleu"], fabrication: ["Fabrication", "bleu"], corrections: ["Corrections", "bleu"],
  bloque: ["Bloqué", "rouge"], livre: ["Livré · à valider", "orange"], mise_en_production: ["Mise en production", "bleu"],
  en_production: ["En production", "vert"], echec: ["Échec", "rouge"], arrete: ["Arrêté", ""], abandonne: ["Abandonné", ""],
}
const BRIQUES = { webapp: "Application web", site: "Site vitrine", api: "API", pwa: "Application mobile" }
const badgeStatut = (s) => html`<span class="badge ${(STATUTS[s] ?? ["", ""])[1]}">${(STATUTS[s] ?? [s])[0]}</span>`
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
      <span style="flex:1">Rechercher un projet, lancer une commande…</span><span class="touche mono">Ctrl K</span>
    </button>
    ${u ? (u.arretee
      ? html`<div class="rangee"><span class="etat-usine" style="color:var(--signal)"><span class="point alerte"></span>Usine à l'arrêt${occupe ? " après la tâche en cours" : ""}</span><button type="button" class="btn btn-s btn-petit" data-action="usine" data-quoi="reprendre">Reprendre</button></div>`
      : html`<div class="etat-usine"><span class="point"></span>Usine en marche${occupe ? ` · ${occupe} tâche en cours` : " · au repos"}</div>`) : ""}
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
    <div class="entete">
      <div><h1>Projets</h1><p class="chapeau">Ce qui se fabrique, ce qui attend une décision, ce qui est en ligne.</p></div>
      <a href="#/nouveau" class="btn btn-p">+ Nouveau projet</a>
    </div>
    ${messageGlobal()}
    ${bandeauPremiersPas()}
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
        <thead><tr><th>Projet</th><th>Type</th><th>État</th><th>Avancement</th><th>Coût</th><th>Adresses</th></tr></thead>
        <tbody>${projets.map((p) => {
          const a = p.avancement
          const pct = a.total ? Math.round((a.finies / a.total) * 100) : 0
          return html`<tr>
            <td><a class="lien-projet" href="#/projets/${p.id}">${p.nom}</a><div class="sous">${p.resume}</div></td>
            <td>${p.repris ? "Dépôt repris" : BRIQUES[p.brique] ?? "—"}</td>
            <td>${badgeStatut(p.statut)}${p.escalades ? html` <span class="badge orange">${p.escalades} décision</span>` : ""}</td>
            <td style="min-width:180px"><div class="rangee" style="flex-wrap:nowrap"><div class="jauge ${p.statut === "en_production" || p.statut === "livre" ? "verte" : ""}" style="flex:1"><div style="width:${pct}%"></div></div><span class="mono aide">${a.finies}/${a.total}</span></div>
              <div class="sous">${a.en_cours ? `${a.en_cours.cle} ${a.en_cours.statut === "verification" ? "en vérification" : "en cours"}` : p.apercu_vie && p.apercu_vie !== "—" ? `aperçu : ${p.apercu_vie}` : ""}</div></td>
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

function vueNouveau() {
  if (etat.depart === "depot") return vueReprendre()
  const choix = [
    ["webapp", "Outil métier, tableau de bord, back-office"],
    ["pwa", "Installable sur le téléphone, marche hors réseau"],
    ["site", "Pages publiques référencées, formulaire de contact"],
    ["api", "Relier des logiciels, sans écrans, avec clé d'API"],
  ]
  return html`
    ${barreHaut()}
    <div class="colonnes">
      <form class="colonne-large" data-form="nouveau" style="gap:22px">
        <div><a class="retour" href="#/">← Projets</a><h1 style="margin-top:8px">Que veux-tu construire ?</h1>
          <p class="chapeau">Décris le besoin comme à un collègue. L'analyste pose ses questions s'il en a, puis te propose un plan à valider.</p></div>
        ${choixDepart()}
        ${messageGlobal()}
        <div class="pile"><label class="titre-champ" for="demande">La demande</label>
          <textarea id="demande" name="prompt" class="champ" rows="8" required minlength="20" style="resize:vertical;line-height:1.6" placeholder="Ex. : une application pour nos techniciens de maintenance : chaque matin ils voient leurs interventions du jour, sur place ils saisissent le compte rendu (photos, pièces changées, signature), même sans réseau. Le responsable suit tout depuis un tableau de bord."></textarea>
          <div class="aide">Pour aller plus vite, précise : qui l'utilise · les écrans clés · ce qui n'est pas demandé.</div></div>
        <div class="pile">
          <label class="titre-champ" for="pieces">Pièces jointes <span class="aide" style="font-weight:400">· maquettes, captures ou cahier des charges : PNG, JPEG, WebP ou PDF, 3 au plus, 2 Mo chacune</span></label>
          <input id="pieces" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" multiple class="champ" style="padding:9px">
          ${etat.pieces.length ? html`<ul class="pieces">${etat.pieces.map((f, i) => html`<li><span class="mono">${f.name}</span><span class="aide">${Math.ceil(f.size / 1024)} Ko</span><button type="button" class="btn-icone" data-action="retirer-piece" data-id="${i}" aria-label="Retirer ${f.name}">✕</button></li>`)}</ul>` : ""}
          <div class="aide">L'analyste les lit avant de planifier ; elles sont ensuite copiées dans le dépôt (docs/maquettes/) pour les agents.</div>
        </div>
        ${champPersona()}
        <fieldset><legend>Type de produit <span class="aide" style="font-weight:400">· une indication pour l'analyste, qui choisit en dernier ressort</span></legend>
          <div class="briques">${choix.map(([id, texte]) => html`<button type="button" class="brique" data-action="brique" data-id="${id}" aria-pressed="${String(etat.brique === id)}"><strong>${BRIQUES[id]}</strong><span>${texte}</span></button>`)}</div>
        </fieldset>
        <div class="rangee"><button type="submit" class="btn btn-p">Lancer l'analyse</button><a href="#/" class="btn btn-s">Annuler</a></div>
      </form>
      <aside class="colonne-etroite" aria-label="Comment ça se passe">
        <div class="carte carte-p pile">
          <strong>Estimation</strong>
          ${etat.estimation?.disponible ? html`<div style="font-size:14px">Un projet typique de l'usine : <strong>${etat.estimation.taches} tâches</strong>, <strong>${etat.estimation.cout}</strong> en équivalent API, <strong>${etat.estimation.duree}</strong> de calcul.</div>
            <div class="aide">D'après les ${etat.estimation.mesurees} tâches déjà fabriquées. L'estimation exacte arrive avec le plan, avant que tu le valides.</div>`
          : html`<div class="aide">${etat.estimation ? `Pas encore assez d'historique (${etat.estimation.mesurees} tâche(s) mesurée(s), 5 au moins) : l'estimation apparaîtra avec le plan des prochains projets.` : "Calcul de l'estimation…"}</div>`}
        </div>
        <div class="sombre pile">
          <div class="surtitre" style="color:inherit;opacity:.75">Ce qui va se passer</div>
          <ol style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:14px">
            <li>L'analyste lit la demande et pose ses questions s'il en a.</li>
            <li>Il propose un plan : lots, tâches, critères vérifiables, brief de design.</li>
            <li><strong>Tu valides le plan</strong> (modifiable ici).</li>
            <li>L'usine code, vérifie et met un aperçu en ligne à chaque lot.</li>
            <li><strong>Tu valides le produit</strong> avant la production.</li>
          </ol>
        </div>
        <div class="carte carte-p pile"><strong>Partir d'un exemple</strong>
          ${["Un CRM léger pour une équipe de 5 commerciaux : contacts, opportunités, relances.", "Le site vitrine d'un cabinet d'architectes, avec réalisations et formulaire de contact.", "Une API qui relie notre ERP à la boutique en ligne : stocks et commandes.", "Le suivi des congés de l'équipe : demandes, validation par le manager, calendrier."].map((x) => html`<button type="button" class="lien-btn" style="text-align:left;padding:4px 0" data-action="exemple" data-texte="${x}">${x}</button>`)}
        </div>
      </aside>
    </div>`
}

// --- Partir d'un dépôt existant, et les personas -------------------------------------------
const STATUTS_PERSONA = { recherche: ["Recherche en cours", "bleu"], a_valider: ["À relire et valider", "orange"], valide: ["Validé", "vert"], echec: ["Recherche en échec", "rouge"] }
const badgePersona = (s) => html`<span class="badge ${(STATUTS_PERSONA[s] ?? ["", ""])[1]}">${(STATUTS_PERSONA[s] ?? [s])[0]}</span>`
const personasValides = () => (etat.personas ?? []).filter((p) => p.statut === "valide")

// Le choix du point de départ, en tête de « Nouveau projet ».
const choixDepart = () => html`<fieldset><legend class="cache">Point de départ</legend>
  <div class="briques">${[["zero", "Partir de zéro", "Décris le produit : l'usine part d'une de ses briques."], ["depot", "Partir d'un dépôt existant", "Un dépôt GitHub (un reverse engineering, une ébauche) : l'usine le reprend et le termine."]].map(([id, titre, texte]) => html`<button type="button" class="brique" data-action="depart" data-id="${id}" aria-pressed="${String(etat.depart === id)}"><strong>${titre}</strong><span>${texte}</span></button>`)}</div>
</fieldset>`

// Le choix du persona (seuls les personas validés : leur fiche a été relue).
function champPersona(obligatoire = false) {
  const liste = personasValides()
  return html`<div class="pile"><label class="titre-champ" for="persona">Persona <span class="aide" style="font-weight:400">· ${obligatoire ? "pour qui l'usine termine le produit" : "facultatif : pour qui l'usine construit"}</span></label>
    <select id="persona" name="persona_id" class="champ">
      <option value="">${liste.length ? "Aucun persona" : "Aucun persona validé pour l'instant"}</option>
      ${liste.map((p) => html`<option value="${p.id}">${p.nom}</option>`)}
    </select>
    <div class="aide">Sa fiche guide le plan et les agents (ICP.md) ; ses scénarios cachés jugeront le produit fini. <a href="#/personas">Créer ou relire un persona</a>.</div></div>`
}

function vueReprendre() {
  return html`
    ${barreHaut()}
    <div class="colonnes">
      <form class="colonne-large" data-form="reprendre" style="gap:22px">
        <div><a class="retour" href="#/">← Projets</a><h1 style="margin-top:8px">Quel dépôt l'usine reprend-elle ?</h1>
          <p class="chapeau">L'usine fait l'inventaire du dépôt (sa pile, ce qui marche, ce qui manque), le met au contrat d'hébergement, puis l'analyste te propose un plan pour le terminer et le spécialiser.</p></div>
        ${choixDepart()}
        <div class="pile"><label class="titre-champ" for="adresse">Le dépôt GitHub</label>
          <input id="adresse" name="adresse" class="champ mono" required placeholder="https://github.com/proprietaire/depot" autocomplete="off" spellcheck="false">
          <div class="aide">Une autre branche que la principale : …/tree/nom-de-branche. Un dépôt privé doit avoir invité le compte GitHub de l'usine.</div></div>
        ${champPersona(true)}
        <fieldset><legend>Où l'usine travaille</legend>
          ${[["auto", "Automatique", "Directement dans le dépôt si l'usine y est invitée en écriture, sinon dans une copie."], ["direct", "Dans le dépôt d'origine", "Branche usine/…/integration et pull requests dans ton dépôt ; à la fin, une pull request de livraison que tu fusionnes toi-même. Jamais de push sur ta branche principale."], ["copie", "Dans une copie", "L'usine copie le dépôt chez elle et y travaille : l'original n'est jamais touché."]].map(([id, titre, texte]) => html`<label class="rangee" style="align-items:flex-start;gap:10px"><input type="radio" name="mode" value="${id}" ${id === "auto" ? "checked" : ""} style="margin-top:4px"><span><strong>${titre}</strong><span class="aide" style="display:block">${texte}</span></span></label>`)}
        </fieldset>
        <div class="pile"><label class="titre-champ" for="consigne">Ce que tu veux en faire <span class="aide" style="font-weight:400">· facultatif</span></label>
          <textarea id="consigne" name="consigne" class="champ" rows="5" style="resize:vertical;line-height:1.6" placeholder="Ex. : garder l'analyse de mots-clés et l'audit de site, ajouter le suivi de la fiche Google et des avis, pour un commerce de quartier."></textarea></div>
        <div class="rangee"><button type="submit" class="btn btn-p">Lancer l'inventaire</button><a href="#/" class="btn btn-s">Annuler</a></div>
      </form>
      <aside class="colonne-etroite" aria-label="Comment ça se passe">
        <div class="sombre pile">
          <div class="surtitre" style="color:inherit;opacity:.75">Ce qui va se passer</div>
          <ol style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:14px">
            <li>L'usine clone le dépôt et en fait l'inventaire : pile, commandes, ce qui marche.</li>
            <li>Elle le met au contrat d'hébergement (Dockerfile, santé, données), et le code vérifie qu'il démarre.</li>
            <li>L'analyste propose un plan, à partir de l'inventaire et du persona.</li>
            <li><strong>Tu valides le plan.</strong></li>
            <li>L'usine code et vérifie sur sa branche ; à la fin, la recette joue les scénarios cachés du persona.</li>
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
      <div><h1>Personas</h1><p class="chapeau">Pour qui l'usine construit. Tu décris la cible en quelques lignes ; un agent l'approfondit par une recherche sourcée sur le web ; tu relis, tu corriges, tu valides.</p></div>
    </div>
    ${messageGlobal()}
    <div class="colonnes">
      <section class="colonne-large carte" aria-labelledby="liste-personas">
        <div class="barre" style="padding:14px 16px;border-bottom:1px solid var(--trait)"><h2 id="liste-personas">Les personas</h2></div>
        ${!liste ? html`<div class="chargement">Chargement…</div>` : liste.length ? html`<div class="tableau"><table style="min-width:560px">
          <thead><tr><th>Persona</th><th>État</th><th>Sources</th><th>Scénarios cachés</th></tr></thead>
          <tbody>${liste.map((p) => html`<tr>
            <td><a class="lien-projet" href="#/personas/${p.id}">${p.nom}</a><div class="sous">${p.fiche?.resume ?? p.brief}</div></td>
            <td>${badgePersona(p.statut)}</td>
            <td class="mono">${p.fiche?.sources?.length ?? "—"}</td>
            <td class="mono">${p.scenarios?.length || "—"}</td></tr>`)}</tbody></table></div>`
        : html`<div class="vide">Aucun persona pour l'instant : décris le premier à droite.</div>`}
      </section>
      <aside class="colonne-etroite pile">
        <form class="carte carte-p pile" data-form="persona-nouveau">
          <strong>Nouveau persona</strong>
          <label class="titre-champ" for="persona-nom">Son nom</label>
          <input id="persona-nom" name="nom" class="champ" required maxlength="80" placeholder="Ex. : Commerçant de quartier">
          <label class="titre-champ" for="persona-brief">Qui est-ce ?</label>
          <textarea id="persona-brief" name="brief" class="champ" rows="6" required minlength="15" style="resize:vertical;line-height:1.6" placeholder="Ex. : boulangerie de quartier à Lyon, pas de site web, des avis Google, veut être trouvée par les gens du coin. Le gérant n'a pas le temps de faire du référencement."></textarea>
          <div><button type="submit" class="btn btn-p">Lancer la recherche</button></div>
          <div class="aide">L'agent cherche sur le web (études, forums, avis) et rend une fiche sourcée, ce qui est hors périmètre, et 3 à 5 scénarios cachés. Quelques minutes ; plus si l'atelier fabrique une tâche.</div>
        </form>
        <div class="sombre pile"><div class="surtitre" style="color:inherit;opacity:.75">Les scénarios cachés</div>
          <div style="font-size:14px">Ils jugent le produit fini du point de vue du persona. L'agent qui code ne les voit jamais : il ne peut pas coder « pour le test ». La recette les joue à la fin.</div></div>
      </aside>
    </div>`
}

const lignes = (l) => (l ?? []).join("\n")
function vuePersona() {
  const p = etat.persona
  if (!p || p.id !== etat.route.id) return html`${barreHaut()}<div class="chargement">Chargement du persona…</div>`
  const f = p.fiche ?? {}
  const scenarios = etat.personaScenarios ?? p.scenarios ?? []
  const zone = (nom, titre, valeur, aide, rangs = 3) => html`<div class="pile"><label class="titre-champ" for="pf-${nom}">${titre}</label><textarea id="pf-${nom}" name="${nom}" class="champ" rows="${rangs}" style="resize:vertical;line-height:1.5">${valeur}</textarea>${aide ? html`<div class="aide">${aide}</div>` : ""}</div>`
  return html`
    ${barreHaut()}
    <div class="entete">
      <div><a class="retour" href="#/personas">← Personas</a>
        <div class="rangee" style="margin-top:8px;gap:12px"><h1>${p.nom}</h1>${badgePersona(p.statut)}</div>
        <p class="chapeau">${p.brief}</p></div>
    </div>
    ${messageGlobal()}
    ${p.statut === "recherche" ? html`<div class="message info"><span>L'agent approfondit ce persona sur le web. Cette page se met à jour toute seule (quelques minutes ; elle attend si l'atelier fabrique une tâche).</span></div>` : ""}
    ${p.statut === "echec" ? html`<div class="message erreur"><span style="flex:1">La recherche n'a pas abouti : ${p.erreur ?? "raison inconnue"}</span><button type="button" class="btn btn-s btn-petit" data-action="persona-approfondir">Relancer la recherche</button></div>` : ""}
    ${p.fiche ? html`<div class="colonnes">
      <form class="colonne-large pile" data-form="persona" style="gap:18px">
        <section class="carte carte-p pile"><h2>La fiche</h2>
          <div class="pile"><label class="titre-champ" for="pf-nom">Nom</label><input id="pf-nom" name="nom" class="champ" value="${p.nom}" maxlength="80"></div>
          ${zone("resume", "Résumé", f.resume, "Deux phrases : qui il est, ce qu'il cherche à obtenir.", 3)}
          ${zone("problemes", "Ses problèmes", lignes((f.problemes ?? []).map((x) => [x.probleme, x.preuve, x.source].filter(Boolean).join(" | "))), "Un par ligne : problème | preuve | adresse de la source.", 6)}
          ${zone("besoins", "Ses besoins", lignes(f.besoins), "Un par ligne.", 4)}
          ${zone("demographie", "Qui il est", lignes(f.demographie), "Un par ligne.")}
          ${zone("psychographie", "Ce qui le motive, ce qui l'inquiète", lignes(f.psychographie), "Un par ligne.")}
          ${zone("outils_actuels", "Ce qu'il utilise aujourd'hui", lignes(f.outils_actuels), "Un par ligne.")}
          <div class="pile"><label class="titre-champ" for="pf-prix">Ce qu'il est prêt à payer</label><input id="pf-prix" name="prix_acceptable" class="champ" value="${f.prix_acceptable ?? ""}"></div>
          ${zone("objections", "Ce qui le ferait renoncer", lignes(f.objections), "Un par ligne.")}
          ${zone("canaux", "Où le trouver", lignes(f.canaux), "Un par ligne.")}
          ${zone("sources", "Sources", lignes((f.sources ?? []).map((s) => (s.titre ? `${s.titre} | ${s.url}` : s.url))), "Une par ligne : titre | adresse.", 4)}
        </section>
        <section class="carte carte-p pile"><h2>Hors périmètre</h2>
          ${zone("hors_perimetre", "Ce qu'on ne construit pas pour ce persona", lignes(p.hors_perimetre), "Un par ligne. Il rejoint MISSION.md et le plan de chaque projet.", 4)}
        </section>
        <section class="carte carte-p pile"><h2>Scénarios cachés · ${scenarios.length}</h2>
          <div class="aide">De 3 à 5. Jamais écrits dans un dépôt ni montrés à l'agent qui code : la recette les joue à la fin, dans la peau du persona.</div>
          ${scenarios.map((s, i) => html`<fieldset class="carte carte-p pile" data-scenario="${i}" style="background:var(--fond)">
            <div class="rangee" style="justify-content:space-between"><strong>Scénario ${i + 1}</strong><button type="button" class="btn btn-s btn-petit" data-action="persona-retirer-scenario" data-id="${i}">Retirer</button></div>
            <label class="titre-champ" for="ps-titre-${i}">Titre</label><input id="ps-titre-${i}" class="champ" data-champ="titre" value="${s.titre}">
            <label class="titre-champ" for="ps-situation-${i}">Situation</label><textarea id="ps-situation-${i}" class="champ" data-champ="situation" rows="2">${s.situation}</textarea>
            <label class="titre-champ" for="ps-etapes-${i}">Étapes probables <span class="aide" style="font-weight:400">· une par ligne</span></label><textarea id="ps-etapes-${i}" class="champ" data-champ="etapes" rows="3">${lignes(s.etapes)}</textarea>
            <label class="titre-champ" for="ps-attendu-${i}">Résultat attendu</label><textarea id="ps-attendu-${i}" class="champ" data-champ="attendu" rows="2">${s.attendu}</textarea>
          </fieldset>`)}
          ${scenarios.length < 5 ? html`<div><button type="button" class="btn btn-s btn-petit" data-action="persona-ajouter-scenario">+ Ajouter un scénario</button></div>` : ""}
        </section>
        <div class="rangee"><button type="submit" class="btn btn-p">Enregistrer la fiche</button>${p.statut === "a_valider" ? html`<button type="button" class="btn btn-s" data-action="persona-valider">Valider ce persona</button>` : ""}</div>
      </form>
      <aside class="colonne-etroite pile">
        ${p.statut === "valide" ? html`<div class="message ok"><span>Validé${p.valide_par ? ` par ${p.valide_par}` : ""} : il se choisit à la création d'un projet. Une modification le repasse « à valider ».</span></div>` : ""}
        <div class="carte carte-p pile"><strong>Approfondir</strong>
          <label class="cache" for="consignes-persona">Ce que la recherche doit creuser</label>
          <textarea id="consignes-persona" class="champ" rows="4" placeholder="Ex. : creuse les commerces alimentaires, et ce qu'ils paient déjà pour leur visibilité."></textarea>
          <div><button type="button" class="btn btn-s" data-action="persona-approfondir" ${p.statut === "recherche" ? "disabled" : ""}>Relancer la recherche</button></div>
          <div class="aide">L'agent repart de la fiche actuelle et l'améliore.</div></div>
        <div class="carte carte-p pile"><strong>Projets</strong>
          ${p.projets?.length ? html`<ul style="margin:0;padding-left:18px">${p.projets.map((x) => html`<li><a href="#/projets/${x.id}">${x.nom ?? `Projet ${x.id}`}</a> ${badgeStatut(x.statut)}</li>`)}</ul>` : html`<div class="aide">Aucun projet ne l'utilise encore.</div>`}
          ${p.projets?.length ? "" : html`<div><button type="button" class="btn btn-d btn-petit" data-action="persona-supprimer">Supprimer ce persona</button></div>`}</div>
      </aside>
    </div>` : ""}`
}

// La reprise d'un dépôt, dans la page d'un projet : d'où il vient, où l'usine travaille, ce qu'elle a trouvé.
function blocReprise(p) {
  const o = p.origine
  if (!o) return ""
  const inv = p.inventaire
  const ETAT = { marche: ["marche", "vert"], partiel: ["partiel", "orange"], casse: ["cassé", "rouge"] }
  return html`<section class="carte carte-p pile" aria-labelledby="reprise"><h2 id="reprise">Dépôt repris</h2>
    <div class="rangee" style="gap:14px"><a class="mono" href="${o.url}" target="_blank" rel="noopener">${o.depot}</a><span class="aide">branche ${o.branche_source}</span>
      <span class="badge">${o.mode === "direct" ? "travail direct dans le dépôt" : "copie dans un dépôt de l'usine"}</span>${p.profil ? html`<span class="badge">pile ${p.profil.pile}</span>` : ""}</div>
    ${o.mode === "direct" ? html`<div class="aide">L'usine intègre sur <span class="mono">${p.branche}</span> ; elle ne pousse jamais sur ${o.branche_source}.${p.pr_livraison ? "" : " La pull request de livraison s'ouvrira à la fin."}</div>` : ""}
    ${p.pr_livraison ? html`<div class="message ok"><span style="flex:1">Pull request de livraison ouverte : relis-la, puis fusionne-la toi-même.</span><a class="btn btn-s btn-petit" href="${p.pr_livraison}" target="_blank" rel="noopener">Ouvrir la pull request</a></div>` : ""}
    ${inv ? html`<details ${p.statut === "plan_a_valider" ? "open" : ""}><summary style="cursor:pointer;font-weight:600">L'inventaire · ${inv.fonctionnalites.filter((f) => f.etat === "marche").length}/${inv.fonctionnalites.length} fonctionnalité(s) qui marchent, ${inv.tests} test(s)</summary>
      <div class="pile" style="margin-top:10px">
        <p style="margin:0">${inv.resume}</p>
        ${inv.fonctionnalites.length ? html`<ul style="margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:6px">${inv.fonctionnalites.map((f) => html`<li class="rangee" style="flex-wrap:nowrap;align-items:flex-start"><span class="badge ${(ETAT[f.etat] ?? ["", ""])[1]}">${(ETAT[f.etat] ?? [f.etat])[0]}</span><span><strong>${f.nom}</strong>${f.detail ? html`<span class="aide"> · ${f.detail}</span>` : ""}</span></li>`)}</ul>` : ""}
        ${inv.manques.length ? html`<div><strong>Ce qui manque</strong><ul style="margin:4px 0 0;padding-left:18px">${inv.manques.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}
        ${inv.changements.length ? html`<div><strong>Mise au contrat d'hébergement</strong><ul style="margin:4px 0 0;padding-left:18px">${inv.changements.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}
        ${p.profil ? html`<div class="aide mono">installer : ${p.profil.installer} · construire : ${p.profil.construire} · tester : ${p.profil.tester} · démarrer : ${p.profil.demarrer}</div>` : ""}
      </div></details>` : p.statut === "analyse" ? html`<div class="aide">Inventaire en cours…</div>` : ""}
  </section>`
}

// La recette : les scénarios cachés du persona, joués sur le produit fini.
function blocRecette(p) {
  const r = p.recette
  if (!r) return ""
  const ecarts = (r.scenarios ?? []).filter((s) => !s.tenu).length
  return html`<section class="carte carte-p pile" aria-labelledby="recette"><div class="rangee" style="justify-content:space-between"><h2 id="recette">Recette du persona « ${r.persona} »</h2>
    ${r.erreur ? html`<span class="badge rouge">impossible</span>` : html`<span class="badge ${r.tenus === r.total ? "vert" : "orange"}">${r.tenus}/${r.total} scénario(s) tenu(s)</span>`}</div>
    ${r.erreur ? html`<div class="aide">La recette n'a pas pu être jouée : ${r.erreur}</div>` : html`
      ${r.resume ? html`<p style="margin:0">${r.resume}</p>` : ""}
      <ul style="margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:8px">${r.scenarios.map((s) => html`<li class="rangee" style="flex-wrap:nowrap;align-items:flex-start"><span class="badge ${s.tenu ? "vert" : "rouge"}">${s.tenu ? "tenu" : "écart"}</span><span><strong>${s.titre}</strong><span class="aide" style="display:block">${s.tenu ? s.observe : s.ecart || s.observe}</span></span></li>`)}</ul>
      ${ecarts && ["livre", "en_production"].includes(p.statut) ? html`<div><button type="button" class="btn btn-s" data-action="corriger-recette">Corriger les ${ecarts} écart(s)</button></div>` : ""}`}
    <div class="aide">Jouée sur ${String(r.sha ?? "").slice(0, 7)} par le vérificateur, dans la peau du persona. L'agent qui code n'a jamais vu ces scénarios.</div>
  </section>`
}

// Les étapes d'une tâche, d'après son statut.
function etapesTache(t) {
  const noms = ["Agent", "Contrôle", "Sécurité", "Vérificateur", "Design", "Fusion"]
  const fait = t.statut === "fusionnee" ? 6 : t.statut === "verification" ? 3 : 0
  return html`<ol class="etapes" aria-label="Étapes de la tâche">${noms.map((n, i) => html`<li class="${i < fait ? "fait" : i === fait && t.statut !== "fusionnee" ? "encours" : ""}">${n}</li>`)}</ol>`
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
        <p class="aide" style="margin:0">Tout est modifiable : titres, descriptions, critères, dépendances, ordre des tâches et des lots. Les critères doivent rester observables sur l'application en marche. Les numéros se recalculent seuls.</p>
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
  const lotsAbandonnes = new Set(plan.lots.map((_, i) => i + 1).filter((n) => {
    const ts = p.taches.filter((t) => t.lot === n)
    return ts.length && ts.every((t) => t.statut === "abandonnee")
  }))
  const tachesLot = p.taches.filter((t) => t.lot === lotCourant)
  const STT = { fusionnee: ["fusionnée", "ok"], en_cours: ["en cours", "actif"], verification: ["en vérif.", "actif"], prete: ["prête", ""], attente: ["en attente", ""], bloquee: ["bloquée", "actif"], abandonnee: ["abandonnée", ""] }
  const discussion = p.journal.filter((j) => ["demande", "decision", "corrections", "diagnostic", "validation", "plan", "design", "abandon", "production", "domaine"].includes(j.type))
  return html`
    <section class="carte carte-p" aria-label="Lots">
      <div class="barre" style="font-size:14px"><strong>Lots</strong><span class="aide">${p.avancement.fusionnees} tâches fusionnées sur ${p.avancement.total}</span></div>
      <ol class="lots">${plan.lots.map((_, i) => {
        const n = i + 1
        const cls = lotsAbandonnes.has(n) ? "abandonne" : n <= p.lot_livre ? "livre" : n === lotCourant && ["fabrication", "corrections", "creation"].includes(p.statut) ? "courant" : ""
        return html`<li class="mono ${cls}" title="Lot ${n} : ${plan.lots[i].nom}">${n}</li>`
      })}</ol>
      ${plan.lots[lotCourant - 1] ? html`<div style="margin-top:10px;font-size:14px">Lot ${lotCourant} · <strong>${plan.lots[lotCourant - 1].nom}</strong></div>` : ""}
    </section>
    <div class="colonnes">
      <div class="colonne-large">
        <section class="carte carte-p pile" style="gap:14px" aria-label="Tâche en cours">
          ${enCours ? html`
            <div class="barre"><div><span class="mono aide">${enCours.cle}</span> <strong style="font-size:17px">${enCours.titre}</strong></div>
              ${enCours.approche || enCours.tentative ? html`<span style="font-size:13px;color:var(--signal);font-weight:600">${enCours.approche ? `approche ${enCours.approche + 1} · modèle renforcé` : `correction ${enCours.tentative}`}</span>` : ""}</div>
            ${etapesTache(enCours)}` : html`<div class="barre"><strong>${p.statut === "en_production" ? "En production" : p.statut === "livre" ? "Tous les lots sont livrés" : "Aucune tâche en cours"}</strong>${p.statut === "fabrication" ? html`<span class="aide">l'usine passe à la suite</span>` : ""}</div>`}
          <div class="onglets" role="tablist" aria-label="Vues du projet">
            ${[...(enCours ? [["direct", "● En direct"]] : []), ["journal", "Journal"], ["captures", `Captures${p.captures.length ? ` · ${p.captures.length}` : ""}`], ["discussion", "Discussion"]].map(([id, nom]) => html`<button type="button" role="tab" id="onglet-${id}" aria-controls="panneau" aria-selected="${String(onglet === id)}" tabindex="${onglet === id ? "0" : "-1"}" data-action="onglet" data-id="${id}">${nom}</button>`)}
          </div>
          <div role="tabpanel" id="panneau" aria-labelledby="onglet-${onglet}">
          ${onglet === "direct" ? html`<div class="direct mono" role="log" aria-live="off" id="direct">${dessinerDirect()}</div>
            <div class="aide">${enCours.statut === "verification" ? "Le vérificateur reconstruit l'application et teste les critères." : "L'agent code dans son atelier."} Mis à jour toutes les 3 secondes ; les secrets sont masqués.</div>` : ""}
          ${onglet === "journal" ? html`<div class="journal mono" role="log" aria-live="polite" id="journal">
            ${p.journal.map((j) => html`<div class="t-${j.type}"><time>${heure(j.le)}</time>${j.type} · ${nettoyer(j.message.length > 600 ? j.message.slice(0, 600) + "…" : j.message)}</div>`)}
            ${p.etapes.length ? html`<div style="margin-top:8px;color:var(--code-doux)">— suivi —</div>${p.etapes.map((e) => html`<div>${e}</div>`)}` : ""}
          </div>` : ""}
          ${onglet === "captures" ? (p.captures.length ? html`<div class="captures">${p.captures.map((c) => html`<figure><a href="${c.url}" target="_blank" rel="noopener"><img src="${c.url}" alt="Capture ${c.fichier} de la tâche ${c.tache}" loading="lazy"></a><figcaption>${c.tache} · ${c.fichier}</figcaption></figure>`)}</div>` : html`<div class="vide">Les captures arrivent avec chaque tâche vérifiée (ordinateur et mobile).</div>`) : ""}
          ${onglet === "discussion" ? html`<div class="pile" style="gap:12px">
            ${discussion.slice(-20).map((j) => html`<div class="bulle ${j.type === "demande" || j.type === "decision" ? "moi" : "usine"}"><small>${j.type} · ${heure(j.le)}</small>${nettoyer(j.message.length > 900 ? j.message.slice(0, 900) + "…" : j.message)}</div>`)}
            <div class="rangee" style="flex-wrap:nowrap"><label class="cache" for="message-libre">Message à l'usine</label>
              <input id="message-libre" class="champ" placeholder="Une correction, une précision… (pendant la fabrication, elle part à la fin du lot)">
              <button type="button" class="btn btn-p" data-action="message" data-source="message-libre">Envoyer</button></div>
          </div>` : ""}
          </div>
        </section>
      </div>
      <aside class="colonne-etroite" aria-label="Tâches et décisions">
        ${p.escalades.map((e) => html`<section class="carte carte-p pile" style="border-color:var(--signal-trait)">
          <h2 style="font-size:15px;color:var(--signal)">Décision attendue${e.tache ? ` · ${e.tache}` : ""}</h2>
          <p style="margin:0;font-size:14px;color:var(--texte)">${e.raison}</p>
          <label class="cache" for="consigne-${e.id}">Consigne (facultative)</label>
          <textarea id="consigne-${e.id}" class="champ" rows="2" placeholder="Consigne pour l'agent (facultatif)"></textarea>
          ${e.options.map((o) => html`<button type="button" class="btn btn-s" style="justify-content:flex-start;text-align:left" data-action="decider" data-id="${e.id}" data-choix="${o.cle}" title="${o.detail}">${o.cle} · ${o.libelle}</button>`)}
        </section>`)}
        ${tachesLot.length ? html`<section class="carte carte-p"><h2 style="font-size:15px;margin-bottom:10px">Lot ${lotCourant} · tâches</h2>
          <ul class="taches">${tachesLot.map((t) => html`<li><span class="cle mono">${t.cle}</span><span class="titre">${t.titre}</span><span class="st ${(STT[t.statut] ?? ["", ""])[1]}">${(STT[t.statut] ?? [t.statut])[0]}</span></li>`)}</ul></section>` : ""}
        ${p.depot ? html`<section class="carte carte-p pile" style="font-size:14px"><strong>Liens</strong>
          <a href="${p.depot}" target="_blank" rel="noopener">Code sur GitHub</a>
          ${p.apercu ? html`<a href="${p.apercu}" target="_blank" rel="noopener">Aperçu</a>` : ""}
          ${p.production ? html`<a href="${p.production}" target="_blank" rel="noopener">Production</a>` : ""}</section>` : ""}
      </aside>
    </div>`
}

function blocProduction(p) {
  if (!["livre", "en_production"].includes(p.statut)) return ""
  const c = p.production_choix ?? {}
  const radio = (nom, val, titre, sous) => html`<label class="choix"><input type="radio" name="${nom}" value="${val}" ${c[nom] === val ? "checked" : ""}><span><strong>${titre}</strong>${sous ? html`<br><span class="aide">${sous}</span>` : ""}</span></label>`
  return html`
    <div class="colonnes">
      <section class="carte carte-p colonne-large" aria-labelledby="prod" style="gap:20px">
        <h2 id="prod">${p.statut === "en_production" ? "Production · changer les réglages" : "Mettre en production"}</h2>
        ${p.production_texte ? html`<div class="aide">Réglages actuels : ${p.production_texte}</div>` : ""}
        <form class="pile" style="gap:18px" data-form="production">
          <fieldset><legend>Données au démarrage</legend><div class="grille">${radio("donnees", "vide", "Base vide", "les vraies données arrivent avec l'usage")}${radio("donnees", "demo", "Données de démo", "pour une présentation")}</div></fieldset>
          <fieldset><legend>Emails</legend><div class="grille">${radio("emails", "captures", "Capturés", "rien ne part, visibles dans Mailpit")}${radio("emails", "reels", "Réels, destinataires autorisés", "seulement vers la liste ci-dessous")}</div>
            <label class="aide" for="destinataires">Destinataires autorisés (adresses ou @domaine, séparés par des virgules)</label>
            <input id="destinataires" name="destinataires_autorises" class="champ" value="${(c.destinataires_autorises ?? []).join(", ")}"></fieldset>
          <fieldset><legend>Accès</legend><div class="grille">${radio("acces", "protege", "Protégé", "page de connexion de l'usine")}${radio("acces", "public", "Public", "ouvert à tous, sans connexion")}</div></fieldset>
          <fieldset><legend>Horloge</legend><div class="grille">${radio("horloge", "reelle", "Réelle")}${radio("horloge", "acceleree", "Accélérée", "un jour = une minute (démo)")}</div></fieldset>
          <div class="confirmer" role="alertdialog" aria-labelledby="conf-prod" id="conf-production" hidden>
            <strong id="conf-prod" style="font-size:16px">Mettre ${p.nom} en production ?</strong>
            <ul style="margin:0;padding-left:18px;font-size:14px;color:var(--texte)"><li>Dernière version vérifiée, avec les réglages ci-dessus.</li><li>Bascule sans coupure ; sauvegarde des données avant.</li><li>Ta validation est tracée dans le dépôt d'état.</li></ul>
            <div class="rangee"><button type="submit" class="btn btn-p">Oui, mettre en production</button><button type="button" class="btn btn-s" data-action="annuler" data-quoi="production">Annuler</button></div>
          </div>
          <div class="rangee" id="btn-production"><button type="button" class="btn btn-p" data-action="confirmer" data-quoi="production">${p.statut === "en_production" ? "Appliquer en production" : "Mettre en production"}</button></div>
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
          ${p.statut === "en_production" ? html`<form class="rangee" style="flex-wrap:nowrap" data-form="domaine"><label class="cache" for="hote">Nouveau domaine</label><input id="hote" name="hote" class="champ" placeholder="app.mon-entreprise.fr"><button type="submit" class="btn btn-s">Ajouter</button></form>` : html`<div class="aide">Un domaine personnalisé s'ajoute une fois le produit en production.</div>`}
        </section>
        ${p.apercu ? html`<section class="carte carte-p pile"><h2 style="font-size:15px">Aperçu</h2>
          <div style="font-size:14px">${p.apercu_garde ? "Gardé sans limite de durée." : `Durée de vie : ${p.apercu_vie}.`}</div>
          <div class="rangee"><button type="button" class="btn btn-s btn-petit" data-action="apercu" data-quoi="prolonger">Prolonger</button>${p.apercu_garde ? "" : html`<button type="button" class="btn btn-s btn-petit" data-action="apercu" data-quoi="garder">Garder</button>`}<button type="button" class="btn btn-d btn-petit" data-action="apercu" data-quoi="retirer">Retirer</button></div></section>` : ""}
      </aside>
    </div>`
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
    <span class="aide">${creation ? "La relance recrée le dépôt et le socle avec le plan déjà validé, sans repasser par l'analyste." : "La relance repart de la demande d'origine."}</span>
    <div><button type="button" class="btn btn-p btn-petit" data-action="relancer-projet">Relancer</button></div>
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
        <div class="rangee" style="margin-top:8px;gap:12px"><h1>${p.nom}</h1>${badgeStatut(p.statut)}${p.brique ? html`<span class="badge">${BRIQUES[p.brique] ?? p.brique}</span>` : ""}${p.repris ? html`<span class="badge">Dépôt repris</span>` : ""}${p.persona ? html`<a class="badge bleu" href="#/personas/${p.persona_id}" style="text-decoration:none">Persona : ${p.persona}</a>` : ""}${p.cout ? html`<span class="badge mono">${p.cout}${p.budget ? ` / ${p.budget}` : ""}</span>` : ""}</div>
        <p class="chapeau">${p.resume}</p></div>
      <div class="rangee">
        ${p.apercu ? html`<a class="btn btn-s" href="${p.apercu}" target="_blank" rel="noopener">Ouvrir l'aperçu</a>` : ""}
        ${p.depot ? html`<a class="btn btn-s" href="${p.depot}" target="_blank" rel="noopener">Code</a>` : ""}
      </div>
    </div>
    ${messageGlobal()}
    ${p.statut === "analyse" ? html`<div class="message info"><span>${p.repris && !p.inventaire ? "L'usine fait l'inventaire du dépôt (pile, commandes, ce qui marche) et le met au contrat d'hébergement ; puis l'analyste prépare le plan." : "L'analyste étudie la demande et prépare le plan."} Cette page se met à jour toute seule.</span></div>` : ""}
    ${p.statut === "echec" ? blocEchec(p) : ""}
    ${blocReprise(p)}
    ${p.statut === "questions" ? html`<section class="carte carte-p pile"><h2>L'analyste a des questions</h2>
      <ol style="margin:0;padding-left:20px">${(p.plan?.questions ?? []).map((q) => html`<li>${q}</li>`)}</ol>
      <label class="cache" for="reponses">Tes réponses</label><textarea id="reponses" class="champ" rows="5" placeholder="Réponds librement, dans l'ordre des questions."></textarea>
      <div><button type="button" class="btn btn-p" data-action="message" data-source="reponses">Envoyer les réponses</button></div></section>` : ""}
    ${enPlan ? blocPlan(p) : ""}
    ${!enPlan && p.plan?.lots?.length && !["analyse", "questions"].includes(p.statut) ? blocFabrication(p) : ""}
    ${blocRecette(p)}
    ${blocProduction(p)}
    ${blocVideo(p)}
    <details class="carte carte-p" id="zone-sensible" ${etat.detailsOuvert ? "open" : ""}><summary style="cursor:pointer;font-weight:600">La demande d'origine et la zone sensible</summary>
      <p style="white-space:pre-wrap;color:var(--texte)">${p.prompt}</p>
      <div class="confirmer" role="alertdialog" aria-labelledby="conf-sup" id="conf-supprimer" hidden><strong id="conf-sup">Supprimer ${p.nom} ?</strong>
        <div style="font-size:14px">L'aperçu et la production s'arrêtent et la place est libérée. Le code reste sur GitHub et les données de production restent sur le serveur.</div>
        <div class="rangee"><button type="button" class="btn btn-d" data-action="supprimer">Oui, supprimer le projet</button><button type="button" class="btn btn-s" data-action="annuler" data-quoi="supprimer">Annuler</button></div></div>
      <div id="btn-supprimer"><button type="button" class="btn btn-d btn-petit" data-action="confirmer" data-quoi="supprimer">Supprimer le projet</button></div>
    </details>`
}

function vueSante() {
  const s = etat.sante
  if (!s) return html`${barreHaut()}<div class="chargement">Mesure de la santé de l'usine…</div>`
  const max = Math.max(1e-9, ...s.couts.evolution.map((e) => Math.max(e.api, e.reel)))
  const mj = s.serveur?.mise_a_jour
  return html`
    ${barreHaut()}
    <div class="entete"><div><h1>Santé et coûts</h1><p class="chapeau">Mesuré chaque minute · une alerte Slack seulement quand un état change.</p></div>
      ${mj?.disponible ? html`<div class="carte rangee" style="padding:10px 14px;gap:12px"><span><strong>Mise à jour disponible</strong> · ${mj.disponible} changement(s)</span><button type="button" class="btn btn-p" data-action="usine" data-quoi="mettre-a-jour">Mettre à jour l'usine</button></div>` : ""}</div>
    ${messageGlobal()}
    <section class="pile" aria-labelledby="services">
      <h2 id="services" class="surtitre">Composants · ${s.composants.filter((c) => c.etat === "ok").length}/${s.composants.length} en bon état</h2>
      <div class="grille" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px">${s.composants.map((c) => html`<div class="carte" style="padding:12px 14px;display:flex;gap:10px;align-items:flex-start">
        <span class="point ${c.etat === "ok" ? "" : c.etat}" style="margin-top:7px" aria-hidden="true"></span>
        <span style="min-width:0"><strong style="font-size:14px">${c.nom}</strong><br><span class="aide">${c.detail}</span></span></div>`)}</div>
    </section>
    <section class="carte carte-p pile" style="gap:16px" aria-labelledby="couts">
      <div class="barre"><h2 id="couts">Coûts du mois</h2><span class="aide">équivalent API et coût réel · <a href="/couts">détail complet</a></span></div>
      <div class="grille">
        <div><div class="aide">Équivalent API</div><div style="font-size:26px;font-weight:700">${s.couts.api}</div></div>
        <div><div class="aide">Coût réel</div><div style="font-size:26px;font-weight:700">${s.couts.reel}</div></div>
        <div><div class="aide">Budget mensuel${s.couts.budget ? ` · ${s.couts.budget}` : ""}</div>
          ${s.couts.pct !== null ? html`<div class="jauge bleue" style="height:12px;margin-top:10px"><div style="width:${Math.min(100, s.couts.pct)}%"></div></div><div class="aide" style="margin-top:6px">${s.couts.pct} % · alertes à 50, 80 et 100 %</div>` : html`<div style="font-size:18px;font-weight:600">non défini</div>`}</div>
      </div>
      <div class="graph" aria-label="Coûts des six derniers mois">${s.couts.evolution.map((e) => html`<div title="${e.mois} : ${e.api_texte} équivalent API, ${e.reel_texte} réel"><i style="height:${Math.round((e.api / max) * 100)}%"></i><i class="reel" style="height:${Math.round((e.reel / max) * 100)}%"></i></div>`)}</div>
      <div class="graph-legende">${s.couts.evolution.map((e) => html`<span>${e.mois.slice(5)}/${e.mois.slice(2, 4)}</span>`)}</div>
      <div class="rangee aide"><span><span class="badge bleu">■</span> équivalent API</span><span><span class="badge vert">■</span> coût réel</span></div>
      <div class="tableau"><table style="min-width:560px"><thead><tr><th>Projet</th><th>État</th><th>Équiv. API</th><th>Réel</th><th>Budget</th><th>Refus</th></tr></thead>
        <tbody>${s.couts.projets.map((p) => html`<tr><td><a class="lien-projet" href="#/projets/${p.id}">${p.nom}</a></td><td>${badgeStatut(p.statut)}</td><td class="mono">${p.mesure ? p.api : "non mesuré"}</td><td class="mono">${p.mesure ? p.reel : "—"}</td><td>${p.budget_pct !== null ? html`<span class="${p.budget_pct >= 80 ? "badge orange" : "aide"}">${p.budget_pct} %</span>` : "—"}</td><td>${p.refus}</td></tr>`)}</tbody></table></div>
    </section>
    <section class="carte carte-p pile"><h2>Pilotage de l'usine</h2>
      <div class="rangee"><button type="button" class="btn btn-s" data-action="usine" data-quoi="stop">Arrêter après la tâche en cours</button><button type="button" class="btn btn-s" data-action="usine" data-quoi="reprendre">Reprendre</button></div>
      <div class="aide">L'arrêt laisse finir la tâche en cours ; rien n'est perdu.</div></section>`
}

function vueAcces() {
  const a = etat.acces
  if (!a) return html`${barreHaut()}<div class="chargement">Chargement des accès…</div>`
  const projets = (etat.resume?.projets ?? []).filter((p) => p.statut !== "abandonne")
  const slugs = Object.entries(a.noms)
  const options = html`<option value="*">Toutes les applications</option>${slugs.map(([slug, nom]) => html`<option value="${slug}">${nom ?? slug}</option>`)}`
  const decrire = (u) => (u.role === "admin" ? "tout, dont la console" : u.applis.includes("*") ? "toutes les applications" : u.applis.map((s) => a.noms[s] ?? s).join(", ") || "aucune")
  return html`
    ${barreHaut()}
    <div><h1>Accès et clés d'API</h1><p class="chapeau">Chaque application est derrière la page de connexion de l'usine. Les personnes entrent par invitation ; les programmes, avec une clé.</p></div>
    ${messageGlobal()}
    <section class="carte" aria-labelledby="personnes">
      <div class="barre" style="padding:14px 16px;border-bottom:1px solid var(--trait)"><h2 id="personnes">Personnes</h2></div>
      <div class="tableau"><table style="min-width:640px"><thead><tr><th>Personne</th><th>Rôle</th><th>Applications</th><th>État</th><th><span class="cache">Actions</span></th></tr></thead>
        <tbody>${a.utilisateurs.map((u) => html`<tr><td><strong>${u.email}</strong>${u.nom ? html`<div class="sous">${u.nom}</div>` : ""}</td><td>${u.role === "admin" ? "Administrateur" : "Membre"}</td><td>${decrire(u)}</td>
          <td>${u.active ? html`<span class="badge vert">actif</span>` : html`<span class="badge orange">invitation en attente</span>`}</td>
          <td style="text-align:right;white-space:nowrap">${u.active ? "" : html`<button type="button" class="btn btn-s btn-petit" data-action="renvoyer" data-id="${u.id}">Renvoyer l'invitation</button> `}${etat.confirmer === `retirer-${u.id}` ? html`<button type="button" class="btn btn-d btn-petit" data-action="retirer-personne" data-id="${u.id}">Confirmer le retrait</button> <button type="button" class="btn btn-s btn-petit" data-action="annuler">Annuler</button>` : html`<button type="button" class="btn btn-s btn-petit" data-action="confirmer" data-quoi="retirer-${u.id}">Retirer l'accès</button>`}</td></tr>`)}</tbody></table></div>
      ${etat.invitation ? html`<div class="message info" style="margin:16px">${etat.invitation}</div>` : ""}
      <form class="pile" style="padding:16px;border-top:1px solid var(--trait-2)" data-form="inviter">
        <strong>Inviter une personne</strong>
        <div class="grille">
          <div class="pile" style="gap:6px"><label class="aide" for="inv-email">Adresse email</label><input id="inv-email" name="email" type="email" class="champ" required></div>
          <div class="pile" style="gap:6px"><label class="aide" for="inv-role">Rôle</label><select id="inv-role" name="role" class="champ"><option value="membre">Membre : les applications choisies</option><option value="admin">Administrateur : tout</option></select></div>
          <div class="pile" style="gap:6px"><label class="aide" for="inv-applis">Applications (membre)</label><select id="inv-applis" name="applis" class="champ" multiple size="3">${options}</select></div>
        </div>
        <div><button type="submit" class="btn btn-p">Envoyer l'invitation</button></div>
      </form>
    </section>
    <section class="carte" aria-labelledby="cles">
      <div class="barre" style="padding:14px 16px;border-bottom:1px solid var(--trait)"><div><h2 id="cles">Clés d'API</h2><div class="aide">En-tête <span class="mono">Authorization: Bearer &lt;clé&gt;</span> · seule l'empreinte est gardée</div></div></div>
      ${etat.cleCreee ? html`<div class="cle-unique" role="status" style="margin:16px"><strong>Copie la clé maintenant : elle ne sera plus jamais affichée.</strong>
        <div class="rangee" style="flex-wrap:nowrap"><code class="mono" id="cle-texte">${etat.cleCreee}</code><button type="button" class="btn" style="background:var(--fond);color:var(--encre)" data-action="copier-cle">Copier</button><button type="button" class="btn" style="background:var(--fond);color:var(--encre)" data-action="fermer-cle">C'est fait</button></div></div>` : ""}
      ${a.cles.length ? html`<div class="tableau"><table style="min-width:640px"><thead><tr><th>Nom</th><th>Début</th><th>Applications</th><th>Dernier usage</th><th><span class="cache">Actions</span></th></tr></thead>
        <tbody>${a.cles.map((c) => html`<tr><td><strong>${c.nom}</strong><div class="sous">créée le ${heure(c.cree_le)}${c.cree_par ? ` par ${c.cree_par}` : ""}</div></td><td class="mono">${c.debut}…</td><td>${c.applis.includes("*") ? "toutes" : c.applis.map((s) => a.noms[s] ?? s).join(", ")}</td><td>${c.utilisee_le ? heure(c.utilisee_le) : html`<span class="aide">jamais</span>`}</td>
          <td style="text-align:right"><button type="button" class="btn btn-d btn-petit" data-action="revoquer" data-id="${c.id}">Révoquer</button></td></tr>`)}</tbody></table></div>` : html`<div class="vide">Aucune clé pour l'instant.</div>`}
      <form class="pile" style="padding:16px;border-top:1px solid var(--trait-2)" data-form="cle">
        <strong>Créer une clé</strong>
        <div class="grille">
          <div class="pile" style="gap:6px"><label class="aide" for="cle-nom">Nom (qui s'en sert)</label><input id="cle-nom" name="nom" class="champ" required maxlength="60" placeholder="intégration CRM"></div>
          <div class="pile" style="gap:6px"><label class="aide" for="cle-applis">Applications</label><select id="cle-applis" name="applis" class="champ" multiple size="3" required>${options}</select></div>
        </div>
        <div><button type="submit" class="btn btn-s">Créer la clé</button></div>
      </form>
    </section>
    ${projets.length ? "" : ""}`
}

const ROLES = { analyste: "Analyste (plan)", atelier: "Agents (code)", verificateur: "Vérificateur", petites_taches: "Petites tâches", produit: "Dans les produits", renfort: "Renfort (autre approche)" }
const POLITIQUES = { jamais: "jamais", manuel: "un humain décide", "sur-criteres": "automatique si les critères passent" }
const ACTIONS_POLITIQUES = { implementer: "Coder une tâche", merger: "Fusionner", deployer_apercu: "Mettre un aperçu en ligne", mettre_en_production: "Mettre en production", supprimer_des_donnees: "Supprimer des données" }

// --- Fournisseurs d'IA ---------------------------------------------------------------------
const NOMS_MODES = {
  "claude-code": { abonnement: "Abonnement Claude (Pro/Max)", cle: "Clé API Anthropic", passerelle: "Passerelle Vercel AI Gateway" },
  codex: { abonnement: "Abonnement ChatGPT", cle: "Clé API OpenAI", passerelle: "Passerelle Vercel AI Gateway" },
}
const ROLES_MODELES = { analyste: "Analyste (plan)", atelier: "Agents (code)", renfort: "Renfort (autre approche)", relecteur: "Relecteurs", petites_taches: "Petites tâches" }
const MODELES_CONNUS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"]
const dateCourte = (le) => (le ? new Date(le).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "")

function badgeTest(t) {
  if (!t) return html`<span class="badge">pas encore testé</span>`
  if (t.etat === "ok") return html`<span class="badge vert">fonctionne</span>`
  if (t.etat === "absent") return html`<span class="badge">non configuré</span>`
  return html`<span class="badge rouge" title="${t.detail ?? ""}">en erreur</span>`
}

// Une valeur secrète : son origine (console ou serveur), jamais la valeur elle-même.
function champIdentifiant(f, nom, aide) {
  const i = f.identifiants.find((x) => x.nom === nom)
  const source = i.console ? html`<span class="badge vert">console · …${i.console.fin}</span> <span class="aide">le ${dateCourte(i.console.le)} par ${i.console.par}</span>`
    : i.serveur ? html`<span class="badge">serveur</span> <span class="aide">posée sur le serveur (secours)</span>` : html`<span class="badge orange">aucune</span>`
  return html`<form class="pile" style="gap:6px" data-form="identifiant" data-nom="${nom}">
    <div class="barre" style="flex-wrap:wrap;gap:6px"><label class="aide" for="id-${nom}"><strong>${i.libelle}</strong></label><span>${source}</span></div>
    <div class="rangee" style="flex-wrap:nowrap"><input id="id-${nom}" name="valeur" type="password" class="champ mono" autocomplete="off" spellcheck="false" placeholder="${i.console || i.serveur ? "Coller une nouvelle valeur pour la remplacer" : "Coller la valeur"}" required>
    <button type="submit" class="btn btn-s">Enregistrer</button>
    ${i.console ? html`<button type="button" class="btn btn-s" data-action="retirer-identifiant" data-nom="${nom}">Retirer</button>` : ""}</div>
    ${aide ? html`<div class="aide">${aide}</div>` : ""}
  </form>`
}

function carteMoteur(f, m) {
  const tests = f.tests.resultats?.[m.id] ?? {}
  const tous = [...m.modes, ...["abonnement", "cle", "passerelle"].filter((x) => !m.modes.includes(x))]
  const chat = etat.chatgpt
  return html`<div class="carte carte-p pile" style="gap:14px">
    <div><strong>${m.libelle}</strong><div class="aide">Les façons de s'en servir, dans l'ordre : quand l'une atteint sa limite ou n'a plus de crédit, l'usine passe à la suivante pour le même travail.</div></div>
    <div class="tableau"><table><tbody>${tous.map((mode) => {
      const actif = m.modes.includes(mode)
      const rang = m.modes.indexOf(mode)
      return html`<tr>
        <td style="width:2.5em">${actif ? html`<strong>${rang + 1}</strong>` : html`<span class="aide">—</span>`}</td>
        <td>${actif ? NOMS_MODES[m.id][mode] : html`<span class="aide">${NOMS_MODES[m.id][mode]} (désactivée)</span>`}</td>
        <td>${badgeTest(tests[mode])}</td>
        <td style="text-align:right;white-space:nowrap">
          ${actif && rang > 0 ? petitBouton("mode-monter", `data-moteur="${m.id}" data-mode="${mode}"`, "↑", `Passer ${NOMS_MODES[m.id][mode]} avant`) : ""}
          <button type="button" class="btn btn-s" data-action="mode-basculer" data-moteur="${m.id}" data-mode="${mode}">${actif ? "Désactiver" : "Activer"}</button>
        </td></tr>`
    })}</tbody></table></div>
    ${m.id === "claude-code" ? html`
      ${champIdentifiant(f, "CLAUDE_CODE_OAUTH_TOKEN", brut(`Sur ton ordinateur, lance <span class="mono">claude setup-token</span>, connecte-toi à ton compte Claude, puis colle ici le jeton affiché (il commence par <span class="mono">sk-ant-oat</span>, valable un an).`))}
      ${champIdentifiant(f, "ANTHROPIC_API_KEY", brut(`Sur <span class="mono">console.anthropic.com</span>, rubrique API Keys. Payée à l'usage.`))}` : html`
      <div class="pile" style="gap:6px">
        <div class="barre" style="flex-wrap:wrap;gap:6px"><strong class="aide">Abonnement ChatGPT du vérificateur</strong>${badgeTest(tests.abonnement)}</div>
        ${chat?.etat === "code" ? html`<div class="carte carte-p pile" style="gap:6px;border-color:var(--accent)"><div>Ouvre <a href="${chat.url}" target="_blank" rel="noopener noreferrer">${chat.url}</a>, connecte-toi à ton compte ChatGPT et saisis ce code :</div><div class="mono" style="font-size:22px;letter-spacing:2px"><strong>${chat.code}</strong></div><div class="aide">Valable 15 minutes. Cette page se met à jour toute seule quand c'est fait.</div></div>`
          : chat?.etat === "attente" ? html`<div class="aide">Le vérificateur prépare le lien de connexion…</div>`
          : html`<div><button type="button" class="btn btn-s" data-action="connecter-chatgpt">${tests.abonnement?.etat === "ok" ? "Reconnecter un compte ChatGPT" : "Connecter un compte ChatGPT"}</button></div>`}
      </div>
      ${champIdentifiant(f, "OPENAI_API_KEY", brut(`Sur <span class="mono">platform.openai.com</span>, rubrique API keys. Payée à l'usage.`))}`}
  </div>`
}

function blocFournisseurs() {
  const f = etat.fournisseurs
  if (!f) return html`<section class="carte carte-p"><div class="chargement">Chargement des fournisseurs d'IA…</div></section>`
  const modeles = f.modeles
  return html`<section class="carte carte-p pile" style="gap:16px" aria-labelledby="fournisseurs">
    <div class="barre" style="flex-wrap:wrap;gap:10px">
      <div><h2 id="fournisseurs">Fournisseurs d'IA</h2><p class="aide" style="margin:4px 0 0">Comment l'usine se connecte aux modèles. Une clé saisie ici est chiffrée, jamais réaffichée, et passe avant celle du serveur ; elle sert dès le prochain travail.</p></div>
      <div class="pile" style="gap:4px;align-items:flex-end"><button type="button" class="btn btn-s" data-action="tester-fournisseurs">Tester les connexions</button><span class="aide">${f.tests.le ? `Dernier test : ${dateCourte(f.tests.le)}` : "Jamais testé"}</span></div>
    </div>
    <div class="grille">${f.moteurs.map((m) => carteMoteur(f, m))}</div>
    <div class="carte carte-p pile" style="gap:10px">
      <div><strong>Passerelle Vercel AI Gateway</strong><div class="aide">Une seule clé pour les modèles de tous les fournisseurs : le secours commun des deux moteurs. Sur <span class="mono">vercel.com</span>, AI Gateway, API Keys. Les produits en ligne gardent la clé posée sur le serveur.</div></div>
      ${champIdentifiant(f, "AI_GATEWAY_API_KEY", "")}
    </div>
    <form class="carte carte-p pile" style="gap:12px" data-form="modeles">
      <div><strong>Modèle de chaque rôle</strong><div class="aide">Un nom de modèle Claude (abonnement, clé ou passerelle). Laisser vide : le modèle du contrat.</div></div>
      <datalist id="modeles-connus">${MODELES_CONNUS.map((x) => html`<option value="${x}"></option>`)}</datalist>
      <div class="grille">${modeles.map((m) => html`<div class="pile" style="gap:6px"><label class="aide" for="mod-${m.role}">${ROLES_MODELES[m.role] ?? m.role}</label><input id="mod-${m.role}" name="${m.role}" class="champ mono" list="modeles-connus" value="${m.modele !== m.contrat ? m.modele : ""}" placeholder="${m.contrat ?? m.modele}" autocomplete="off" spellcheck="false"></div>`)}</div>
      <div><button type="submit" class="btn btn-p">Enregistrer les modèles</button></div>
    </form>
  </section>`
}

// GitHub : l'application de l'usine (recommandé : des jetons qui expirent), ou le jeton du serveur.
function carteGithub(f) {
  const app = f.app ?? { mode: "jeton" }
  const connecte = app.mode === "application" || f.compte?.ok
  const formulaire = html`<form class="pile" style="gap:8px" data-form="github">
    <fieldset class="pile" style="gap:6px;border:0;padding:0;margin:0"><legend class="aide">Les dépôts des produits iront sur</legend>
      <label class="rangee" style="gap:8px"><input type="radio" name="cible" value="perso" checked> mon compte GitHub personnel</label>
      <label class="rangee" style="gap:8px"><input type="radio" name="cible" value="org"> une organisation :</label>
      <input name="organisation" class="champ mono" placeholder="nom-de-l-organisation" autocomplete="off" spellcheck="false" aria-label="Nom de l'organisation GitHub">
    </fieldset>
    <div><button type="submit" class="btn btn-p">Se connecter avec GitHub</button></div>
    <div class="aide">GitHub te demande de créer l'application de l'usine (un clic), puis de l'installer sur « tous les dépôts » : l'usine crée un dépôt par produit. Aucun jeton à copier ; l'usine n'obtient que des accès qui expirent au bout d'une heure.</div>
  </form>`
  return html`<div class="carte carte-p pile" style="border-color:var(--accent);gap:10px">
    <div class="barre"><strong>GitHub</strong>${app.mode === "application" ? html`<span class="badge vert">connecté</span>` : app.mode === "a_installer" ? html`<span class="badge orange">à installer</span>` : f.compte?.ok ? html`<span class="badge vert">connecté (jeton du serveur)</span>` : html`<span class="badge orange">non connecté</span>`}</div>
    ${app.mode === "application" ? html`
      <div style="font-size:14px">Compte : <span class="mono">${app.compte}</span> · ${app.type === "Organization" ? "organisation" : "compte personnel"} · dépôts ${f.visibilite === "public" ? "publics" : "privés"}</div>
      ${app.tous_depots === false ? html`<div class="message erreur">L'application n'a accès qu'à certains dépôts : l'usine ne pourra pas créer ceux des nouveaux produits. Sur GitHub, choisis « All repositories ».</div>` : ""}
      <div class="aide">Connecté le ${dateCourte(app.le)} par ${app.par} · application <span class="mono">${app.slug}</span></div>
      <div class="rangee"><a class="btn btn-s" href="${app.gerer}" target="_blank" rel="noopener noreferrer">Gérer sur GitHub</a><button type="button" class="btn btn-s" data-action="github-oublier">Déconnecter</button></div>`
    : app.mode === "a_installer" ? html`
      <div style="font-size:14px">L'application <span class="mono">${app.slug}</span> est créée : il reste à l'installer sur ton compte ou ton organisation.</div>
      <div class="rangee"><a class="btn btn-p" href="${app.installer}">Installer l'application</a><button type="button" class="btn btn-s" data-action="github-oublier">Recommencer</button></div>`
    : html`
      ${f.compte?.ok ? html`<div style="font-size:14px">Jeton du serveur, compte <span class="mono">${f.compte.login}</span> · dépôts chez <span class="mono">${f.proprietaire}</span>.</div><div class="aide">Recommandé : passer à l'application GitHub de l'usine (accès limités, qui expirent).</div>` : ""}
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
    <div><h1>Réglages</h1><p class="chapeau">Les fournisseurs d'IA, où vont les dépôts des produits, ce que l'usine a le droit de dépenser, et les règles qu'elle applique.</p></div>
    ${messageGlobal()}
    <div><a class="btn btn-s" href="#/demarrer">Premiers pas : revoir les étapes de mise en route</a></div>
    ${blocFournisseurs()}
    <section class="carte carte-p pile" aria-labelledby="forge" style="gap:16px">
      <div><h2 id="forge">Dépôt de code</h2><p class="aide" style="margin:4px 0 0">Chaque produit reçoit son dépôt : le code, une pull request par tâche, les issues du plan.</p></div>
      <div class="grille">
        ${carteGithub(f)}
        <div class="carte carte-p pile" style="gap:8px">
          <div class="barre"><strong>GitLab</strong><span class="badge">prochaine étape</span></div>
          <div style="font-size:14px">GitLab.com ou une instance auto-hébergée : groupes, merge requests, issues.</div>
          <div class="aide">Prévu : le même parcours qu'avec GitHub (dépôt par produit, une merge request par tâche, état souhaité), avec un jeton de groupe GitLab posé sur le serveur.</div>
        </div>
      </div>
    </section>
    <section class="carte carte-p pile" style="gap:10px" aria-labelledby="slack">
      <div class="barre"><h2 id="slack">Slack <span class="aide">(facultatif)</span></h2>${r.slack?.branche ? html`<span class="badge vert">branché</span>` : html`<span class="badge">non branché</span>`}</div>
      <p class="aide" style="margin:0">Tout se fait dans la console. Slack ajoute seulement des notifications et des commandes dans un canal${r.slack?.branche && r.slack.canal ? ` (ici : ${r.slack.canal})` : ""}. Pour le brancher plus tard : une application Slack créée depuis <span class="mono">slack-manifest.yml</span>, puis ses deux jetons posés sur le serveur.</p>
    </section>
    <form class="carte carte-p pile" style="gap:16px" data-form="couts" aria-labelledby="budgets">
      <div><h2 id="budgets">Budgets et coûts</h2><p class="aide" style="margin:4px 0 0">Les budgets portent sur l'équivalent API. Alertes à ${c.alertes.join(", ")} % ; au-delà, l'usine demande avant de continuer. 0 = pas de limite.</p></div>
      <div class="grille">
        <div class="pile" style="gap:6px"><label class="aide" for="b-mensuel">Budget mensuel de l'usine (${c.devise})</label><input id="b-mensuel" name="budget_mensuel" class="champ" inputmode="decimal" value="${c.budget_mensuel}"></div>
        <div class="pile" style="gap:6px"><label class="aide" for="b-projet">Budget par projet (${c.devise})</label><input id="b-projet" name="budget_par_projet" class="champ" inputmode="decimal" value="${c.budget_par_projet}"></div>
        <div class="pile" style="gap:6px"><label class="aide" for="b-serveur">Serveur, par mois (${c.devise})</label><input id="b-serveur" name="serveur_mensuel" class="champ" inputmode="decimal" value="${c.serveur_mensuel}"></div>
        ${c.abonnements.map((a, i) => html`<div class="pile" style="gap:6px"><label class="aide" for="b-ab-${i}">${a.nom}, par mois (${c.devise})</label><input id="b-ab-${i}" name="abonnement" class="champ" inputmode="decimal" value="${a.mensuel}"></div>`)}
      </div>
      <div><button type="submit" class="btn btn-p">Enregistrer</button></div>
    </form>
    <section class="carte carte-p pile" style="gap:16px" aria-labelledby="contrat">
      <div><h2 id="contrat">Le contrat de l'usine</h2><p class="aide" style="margin:4px 0 0">Appliqué par le code, pas par les agents. Il se modifie dans <span class="mono">usine.config.yml</span> sur le serveur.</p></div>
      <div class="colonnes">
        <div class="colonne-large" style="gap:8px"><strong>Modèles</strong>
          <div class="tableau"><table><tbody>${k.modeles.map((m) => html`<tr><td>${ROLES[m.role] ?? m.role}</td><td class="mono">${m.modele}</td><td class="aide">${m.moteur}</td></tr>`)}</tbody></table></div></div>
        <div class="colonne-etroite" style="gap:8px"><strong>Qui décide</strong>
          ${Object.entries(k.politiques).map(([a, v]) => html`<div class="barre" style="font-size:14px"><span>${ACTIONS_POLITIQUES[a] ?? a}</span><span class="badge ${v === "manuel" ? "orange" : v === "jamais" ? "rouge" : "vert"}">${POLITIQUES[v] ?? v}</span></div>`)}</div>
      </div>
      <div class="grille" style="font-size:14px">
        <div><div class="aide">Corrections par tâche</div><strong>${k.autonomie.tentatives_par_tache ?? 2}</strong>, puis ${k.autonomie.changements_d_approche ?? 1} autre approche</div>
        <div><div class="aide">Durée d'un agent</div><strong>${k.autonomie.minutes_max_par_agent ?? 30} min</strong> au plus</div>
        <div><div class="aide">Aperçus</div>retirés après <strong>${k.apercus_jours} jours</strong> sans activité</div>
        <div><div class="aide">Lot de finition</div><strong>${k.finition ? "oui" : "non"}</strong> · mode démo ${k.demo ? "actif" : "inactif"}</div>
      </div>
      <div class="aide">Fichiers protégés des produits : <span class="mono">${k.perimetre_protege.join(" · ")}</span></div>
    </section>`
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

const TYPES_HISTO = { demande: "Demande", validation: "Validation", decision: "Décision", production: "Production", abandon: "Abandon", cycle: "Cycle de vie", plan: "Plan", domaine: "Domaine", corrections: "Corrections", remarque: "Remarque", escalade: "Escalade", erreur: "Erreur", relance: "Relance", reglage: "Réglage" }
function vueHistorique() {
  const h = etat.historique
  const projets = etat.resume?.projets ?? []
  return html`
    ${barreHaut()}
    <div><h1>Historique</h1><p class="chapeau">Qui a fait quoi : demandes, validations, décisions, mises en production, corrections, réglages. Les 200 derniers évènements.</p></div>
    <div class="rangee">
      <label class="aide" for="h-projet">Projet</label>
      <select id="h-projet" class="champ" style="width:auto" data-filtre-histo="projet"><option value="">Tous</option>${projets.map((p) => html`<option value="${p.id}" ${String(p.id) === etat.histoFiltre.projet ? "selected" : ""}>${p.nom}</option>`)}</select>
      <label class="aide" for="h-type">Type</label>
      <select id="h-type" class="champ" style="width:auto" data-filtre-histo="type"><option value="">Tous</option>${Object.entries(TYPES_HISTO).map(([k, v]) => html`<option value="${k}" ${k === etat.histoFiltre.type ? "selected" : ""}>${v}</option>`)}</select>
    </div>
    <section class="carte" aria-label="Évènements">
      ${!h ? html`<div class="chargement">Chargement…</div>` : h.length ? html`<div class="tableau"><table style="min-width:760px"><thead><tr><th>Quand</th><th>Projet</th><th>Type</th><th>Quoi</th><th>Par</th></tr></thead>
        <tbody>${h.map((x) => html`<tr><td class="mono" style="white-space:nowrap">${heure(x.le)}</td><td>${x.projet_id ? html`<a class="lien-projet" href="#/projets/${x.projet_id}">${x.projet ?? `#${x.projet_id}`}</a>` : "—"}</td>
          <td><span class="badge ${["erreur", "escalade"].includes(x.type) ? "orange" : x.type === "production" || x.type === "validation" ? "vert" : ""}">${TYPES_HISTO[x.type] ?? x.type}</span></td>
          <td style="white-space:pre-wrap;word-break:break-word">${nettoyer(x.message.length > 280 ? x.message.slice(0, 280) + "…" : x.message)}</td><td>${x.par ?? html`<span class="aide">usine</span>`}</td></tr>`)}</tbody></table></div>`
      : html`<div class="vide">Rien dans ce filtre.</div>`}
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
    if (["nouveau", "personas"].includes(r.vue)) taches.push(api("GET", "personas").then((x) => { if (frais()) { etat.personas = x.personas; rendre() } }))
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
  return [...document.querySelectorAll("#principal textarea, #principal input:not([type=radio])")].some((x) => x.value && x.defaultValue !== x.value)
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
const PIECES = { max: 3, taille: 2 * 1024 * 1024, types: ["image/png", "image/jpeg", "image/webp", "application/pdf"] }
document.addEventListener("change", (e) => {
  if (e.target.id === "pieces") {
    const choisis = [...e.target.files]
    const refuses = choisis.filter((f) => !PIECES.types.includes(f.type) || f.size > PIECES.taille)
    const toutes = [...etat.pieces, ...choisis.filter((f) => !refuses.includes(f))]
    etat.pieces = toutes.slice(0, PIECES.max)
    if (refuses.length) etat.message = { type: "erreur", texte: `Non retenu : ${refuses.map((f) => f.name).join(", ")} (PNG, JPEG, WebP ou PDF de 2 Mo au plus).` }
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
  "valider-plan": () => agir(() => api("POST", `projets/${etat.projet.id}/valider`, {}), { succes: "Plan validé : l'usine crée le dépôt et commence le lot 1." }),
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
  "corriger-recette": () => confirmer("Envoyer les écarts de la recette à l'analyste ? Il en fera un lot de corrections.") && agir(() => api("POST", `projets/${etat.projet.id}/corriger-recette`, {}), { succes: "Écarts transmis : l'analyste prépare un lot de corrections." }),
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
}, true)

// --- Palette de commandes (Ctrl K) ----------------------------------------------------------
let choixPalette = 0
function entreesPalette(filtre) {
  const f = filtre.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
  const projets = (etat.resume?.projets ?? []).filter((p) => p.statut !== "abandonne").map((p) => ({ texte: p.nom, aide: (STATUTS[p.statut] ?? [p.statut])[0], aller: `#/projets/${p.id}` }))
  const commandes = [
    { texte: "Nouveau projet", aide: "commande", aller: "#/nouveau" },
    { texte: "Projets", aide: "page", aller: "#/" },
    { texte: "Santé et coûts", aide: "page", aller: "#/sante" },
    { texte: "Accès et clés d'API", aide: "page", aller: "#/acces" },
    { texte: "Réglages : dépôt de code, budgets, contrat", aide: "page", aller: "#/reglages" },
    { texte: "Historique : qui a fait quoi", aide: "page", aller: "#/historique" },
    { texte: "Arrêter l'usine après la tâche en cours", aide: "commande", faire: () => confirmer("Arrêter l'usine après la tâche en cours ?") && agir(() => api("POST", "usine/stop", {})) },
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
