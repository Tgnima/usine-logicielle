// La file d'attention : ce qui attend une personne, en trois groupes, avec un seul compte partout
// (l'accueil, la page Visibilité, le titre de l'onglet, les notifications).
//
//   decider     une décision (A, B ou C), un plan, des questions, la fiche d'un public, un produit
//               prêt à mettre en ligne ;
//   debloquer   ce qui ne bougera pas seul, avec une seule action par cas : un projet en échec ou une
//               réorientation dont l'analyse a échoué (Relancer), la fabrication en pause faute
//               d'accès (reprise à telle heure), le coffre des clés verrouillé (à régler sur le
//               serveur), une adresse web qui attend son enregistrement, une fonction arrêtée sans
//               décision ouverte ;
//   reparer     ce qui est en panne : un service de l'usine, la sonde des produits, un produit.
//
// Le compte (titre de l'onglet, notifications) additionne decider et debloquer. reparer reste à
// part et ne s'additionne jamais : une panne se voit en rouge, elle ne gonfle pas le compte.
//
// Lecture seule : rien n'est écrit, aucun service n'est appelé. Les pannes de l'usine viennent du
// dernier bilan de la surveillance (sante.mjs, chaque minute) ; les produits, de la sonde du
// déployeur (produitsAReparer, appelé par visibilite.mjs).
import { obtenir, plan as lirePlan } from "./db.mjs"
import { lireReglage } from "./couts.mjs"
import { enregistrementDns, ipServeur } from "./domaines.mjs"
import { etatFournisseurs } from "./fournisseurs.mjs"
import { facturationsEnCours } from "./moteurs.mjs"
import { normaliserQuestions, presenterDecision } from "./presentation.mjs"
import { reorientationEnPreparation } from "./reorientation.mjs"
import { dernierEtatUsine } from "./sante.mjs"

export const GROUPES = ["decider", "debloquer", "reparer"]

// L'ordre dans un groupe : une décision d'abord ; un projet en échec avant une pause ; une panne de
// l'usine avant celle d'un produit (elle les arrête tous).
const ORDRE = {
  decision: 0, plan: 1, questions: 2, persona: 3, livre: 4,
  echec: 10, pause: 11, coffre: 12, tache: 13, dns: 14,
  usine: 20, sonde: 21, panne: 22,
}
const GROUPE_DU_TYPE = {
  decision: "decider", plan: "decider", questions: "decider", persona: "decider", livre: "decider",
  echec: "debloquer", pause: "debloquer", coffre: "debloquer", tache: "debloquer", dns: "debloquer",
  usine: "reparer", sonde: "reparer", panne: "reparer",
}
export const groupeDe = (type) => GROUPE_DU_TYPE[type] ?? "decider"

// Le groupe d'abord, puis l'ordre du type, puis l'ordre d'arrivée.
export function ordonner(liste) {
  const rang = (x) => GROUPES.indexOf(x.groupe ?? groupeDe(x.type))
  return liste.map((x, i) => [x, i]).sort(([a, i], [b, j]) => rang(a) - rang(b) || (ORDRE[a.type] ?? 9) - (ORDRE[b.type] ?? 9) || i - j).map(([x]) => x)
}

// Le compte, le même partout : decider + debloquer ; reparer à part.
export function compterAttente(liste) {
  const n = (g) => liste.filter((x) => (x.groupe ?? groupeDe(x.type)) === g).length
  const c = { decider: n("decider"), debloquer: n("debloquer"), reparer: n("reparer") }
  return { ...c, total: c.decider + c.debloquer }
}

// --- Outils ------------------------------------------------------------------------------
const TEXTE_MAX = 300
// Le dernier bilan de la surveillance sert pendant 5 minutes ; plus ancien, il ne dit plus l'état présent.
const BILAN_MAX_MS = 5 * 60_000
const FINIES = ["fusionnee", "abandonnee"]
// Les raisons d'une décision où une consigne pour l'agent a un sens (A reprend la fonction, escalade.mjs).
const SANS_CONSIGNE = ["cout", "budget", "livraison"]
const FUSEAU = "Europe/Paris"
// Une fonction « bloquee » sans décision ouverte n'est orpheline qu'au bout de 5 minutes (aDebloquer).
const ORPHELINE_MS = 5 * 60_000
// Une date au format de SQLite (« 2026-11-09 02:25:08 », temps universel), pour comparer à maj_le ou le.
const sqlDate = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

// Une date de SQLite (« 2026-11-09 02:25:08 », temps universel) ou ISO, en ISO ; null si illisible.
function iso(le) {
  const t = String(le ?? "")
  if (!t) return null
  const d = new Date(t.replace(" ", "T") + (/[zZ]$|[+-]\d\d:?\d\d$/.test(t) ? "" : "Z"))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
// La première ligne d'un message (la suite est souvent une pile d'appels), bornée.
const premiereLigne = (t) => String(t ?? "").split("\n")[0].replace(/\s*:\s*$/, "").trim().slice(0, TEXTE_MAX)
// « jusqu'à 15:40 » aujourd'hui, « jusqu'au 14 nov. à 09:00 » un autre jour, à l'heure de Paris.
function jusqua(date, maintenant) {
  const d = new Date(date)
  const jour = (x) => x.toLocaleDateString("fr-FR", { timeZone: FUSEAU })
  const heure = d.toLocaleTimeString("fr-FR", { timeZone: FUSEAU, hour: "2-digit", minute: "2-digit" })
  return jour(d) === jour(new Date(maintenant)) ? `jusqu'à ${heure}` : `jusqu'au ${d.toLocaleDateString("fr-FR", { timeZone: FUSEAU, day: "numeric", month: "short" })} à ${heure}`
}
const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`
// Une réorientation en cours (le réglage de reorientation.mjs, lu comme escalade.mjs le lit).
const enReorientation = (db, projetId) => Boolean(lireReglage(db, `reorientation_${Number(projetId)}`, ""))
const lireJson = (x, defaut) => {
  try {
    return JSON.parse(x) ?? defaut
  } catch {
    return defaut
  }
}

// Les fonctions qui attendent derrière une fonction arrêtée : celles qui en dépendent, directement
// ou par une autre, et qui ne sont pas finies.
export function fonctionsDerriere(taches, cle) {
  const attendent = new Set()
  let front = [cle]
  while (front.length) {
    const suivantes = taches.filter((t) => t.cle !== cle && !attendent.has(t.cle) && !FINIES.includes(t.statut) && lireJson(t.depend_de, []).some((d) => front.includes(d)))
    for (const t of suivantes) attendent.add(t.cle)
    front = suivantes.map((t) => t.cle)
  }
  return attendent.size
}

// L'adresse IP du serveur, pour l'enregistrement à créer : celle de ipServeur (domaines.mjs), relue
// au plus toutes les 10 minutes et sans l'attendre (la file reste synchrone). Tant qu'elle n'est pas
// connue, la carte dit « l'adresse IP du serveur ».
const ip = { valeur: null, le: 0, enCours: false }
function ipConnue(config) {
  if (process.env.IP_PUBLIQUE) return process.env.IP_PUBLIQUE
  if (!ip.enCours && Date.now() - ip.le > 10 * 60_000) {
    ip.enCours = true
    ipServeur(config).then((l) => { ip.valeur = l[0] ?? ip.valeur }).catch(() => {}).finally(() => { ip.le = Date.now(); ip.enCours = false })
  }
  return ip.valeur
}

// --- Décider -----------------------------------------------------------------------------
// raisons : les raisons d'une décision, en clair (RAISONS de console.mjs).
function aDecider(ctx, raisons) {
  const { db } = ctx
  const liste = []
  for (const e of db.prepare("SELECT e.*, p.nom, p.statut AS statut_projet FROM escalades e JOIN projets p ON p.id = e.projet_id WHERE e.statut = 'ouverte' AND p.statut != 'supprime' ORDER BY e.id").all()) {
    // Pendant une réorientation, la décision attend le nouveau plan (resoudre() la refuserait) : il n'y a
    // rien à décider. Le nouveau plan, une fois prêt, est le seul geste ; il dit combien de décisions il règle.
    if (e.statut_projet === "reorientation" || enReorientation(db, e.projet_id)) continue
    const t = e.tache_id ? obtenir(db, "taches", e.tache_id) : null
    const raison = raisons[e.raison] ?? e.raison
    const derriere = t ? fonctionsDerriere(db.prepare("SELECT cle, statut, depend_de FROM taches WHERE projet_id = ?").all(e.projet_id), t.cle) : 0
    const options = lireJson(e.options, [])
    const d = presenterDecision({ raison: e.raison, raisonTexte: raison, options: Array.isArray(options) ? options : [], tache: t })
    liste.push({
      groupe: "decider", type: "decision", cle: `decision:${e.id}`, projet: e.projet_id,
      titre: `${e.nom} · décision attendue`,
      detail: `${t ? `${t.cle} : ` : ""}${raison}${derriere ? ` · ${pluriel(derriere, "fonction attend", "fonctions attendent")} derrière` : ""}`,
      depuis: iso(e.cree_le), lien: `#/projets/${e.projet_id}`,
      derriere,
      // La décision prise sur place : l'option recommandée et sa conséquence d'abord (presenterDecision),
      // puis les autres ; « Autre consigne » quand l'option A reprend la fonction avec une consigne.
      decision: {
        id: e.id,
        tache: t?.cle ?? null,
        consigne: Boolean(t) && !SANS_CONSIGNE.includes(e.raison) && d.options.some((o) => o.cle === "A"),
        options: d.options.map((o) => ({ cle: o.cle, libelle: o.libelle, consequence: o.consequence || o.detail || "", recommande: o.recommande })),
      },
    })
  }
  // depuis : la dernière modification du projet, à peu près le moment où il s'est mis à attendre.
  for (const p of db.prepare("SELECT * FROM projets WHERE statut IN ('plan_a_valider', 'questions', 'livre') ORDER BY id DESC").all()) {
    const plan = lirePlan(p)
    const base = { groupe: "decider", projet: p.id, depuis: iso(p.maj_le), lien: `#/projets/${p.id}` }
    if (p.statut === "plan_a_valider") {
      const reoriente = enReorientation(db, p.id)
      // Les décisions ouvertes du projet : valider le nouveau plan les règle toutes (validerReorientation).
      const ouvertes = reoriente ? db.prepare("SELECT COUNT(*) AS n FROM escalades WHERE projet_id = ? AND statut = 'ouverte'").get(p.id).n : 0
      const lots = plan?.lots?.length ?? 0
      const nTaches = plan?.lots?.reduce((n, l) => n + l.taches.length, 0) ?? 0
      liste.push({ ...base, type: "plan", cle: `plan:${p.id}`, titre: `${p.nom} · ${reoriente ? "nouveau plan (réorientation)" : "plan"} à valider`, detail: `${pluriel(lots, "lot", "lots")}, ${pluriel(nTaches, "tâche", "tâches")}${ouvertes ? ` · ${pluriel(ouvertes, "décision ouverte sera réglée", "décisions ouvertes seront réglées")} par ce plan` : ""}` })
    }
    if (p.statut === "questions") liste.push({ ...base, type: "questions", cle: `questions:${p.id}`, titre: `${p.nom ?? "Nouveau projet"} · l'analyste a des questions`, detail: normaliserQuestions(plan?.questions)[0]?.question ?? "" })
    if (p.statut === "livre") liste.push({ ...base, type: "livre", cle: `livre:${p.id}`, titre: `${p.nom} · prêt à mettre en ligne`, detail: "à mettre en ligne ou à corriger" })
  }
  // Une fiche de public à relire : un projet ne peut viser ce public qu'une fois la fiche validée.
  for (const p of db.prepare("SELECT id, nom, maj_le FROM personas WHERE statut = 'a_valider' ORDER BY id").all()) {
    liste.push({ groupe: "decider", type: "persona", cle: `persona:${p.id}`, projet: null, titre: `${p.nom} · fiche du public à relire`, detail: "Relis la fiche et valide-la : un projet ne peut viser ce public qu'ensuite.", depuis: iso(p.maj_le), lien: `#/personas/${p.id}` })
  }
  return liste
}

// --- Débloquer ---------------------------------------------------------------------------
function aDebloquer(ctx, maintenant) {
  const { db, config } = ctx
  const liste = []

  // Un projet en échec : Relancer, et ce qui sera refait (la même règle que relancerProjet, pipeline.mjs).
  // Une relance notée après la dernière erreur est déjà envoyée : elle n'est plus proposée.
  for (const p of db.prepare("SELECT * FROM projets WHERE statut = 'echec' ORDER BY id DESC").all()) {
    const erreur = db.prepare("SELECT id, message, le FROM journal WHERE projet_id = ? AND type = 'erreur' ORDER BY id DESC LIMIT 1").get(p.id)
    const relance = db.prepare("SELECT id, le FROM journal WHERE projet_id = ? AND type = 'relance' ORDER BY id DESC LIMIT 1").get(p.id)
    const planValide = db.prepare("SELECT 1 FROM decisions WHERE projet_id = ? AND question = 'Plan de fabrication' AND reponse = 'validé'").get(p.id)
    const creation = Boolean(planValide) && !p.debut_fabrication
    liste.push({
      groupe: "debloquer", type: "echec", cle: `echec:${p.id}`, projet: p.id,
      titre: `${p.nom ?? "Nouveau projet"} · ${creation ? "la création a échoué" : lirePlan(p)?.lots?.length ? "en échec" : "l'analyse a échoué"}`,
      detail: premiereLigne(erreur?.message) || "Raison inconnue : voir l'historique du projet.",
      refait: creation ? "Relancer reprend avec le plan déjà validé : rien à refaire de ton côté." : "Relancer repart de ta demande d'origine.",
      action: { type: "relancer", libelle: "Relancer", projet: p.id },
      envoye: relance && (!erreur || relance.id > erreur.id) ? { le: iso(relance.le), texte: "Relance demandée" } : null,
      depuis: iso(erreur?.le ?? p.maj_le), lien: `#/projets/${p.id}`,
    })
  }

  // Une réorientation dont l'analyse a échoué (reorientation.mjs, preparer) : le projet reste en pause et
  // rien ne la relancera seule. Pendant que l'analyste refait la suite du plan, ou qu'il attend la fin de
  // la tâche en cours, elle n'y est pas. Relancer passe par relancerReorientation (relancerProjet).
  for (const p of db.prepare("SELECT id, nom, maj_le FROM projets WHERE statut = 'reorientation' ORDER BY id DESC").all()) {
    if (!enReorientation(db, p.id) || reorientationEnPreparation(p.id)) continue
    const erreur = db.prepare(`SELECT message, le FROM journal WHERE projet_id = ? AND type = 'erreur'
        AND id > (SELECT COALESCE(MAX(id), 0) FROM journal WHERE projet_id = ? AND type = 'reorientation') ORDER BY id DESC LIMIT 1`).get(p.id, p.id)
    liste.push({
      groupe: "debloquer", type: "echec", cle: `reorientation:${p.id}`, projet: p.id,
      titre: `${p.nom ?? "Nouveau projet"} · la réorientation a échoué`,
      detail: premiereLigne(erreur?.message).replace(/^Réorientation\s*:\s*/i, "") || "L'analyste n'a pas pu refaire la suite du plan.",
      refait: "Relancer refait la suite du plan. Tu peux aussi garder l'ancien plan, depuis la page du projet.",
      action: { type: "relancer", libelle: "Relancer", projet: p.id },
      envoye: null,
      depuis: iso(erreur?.le ?? p.maj_le), lien: `#/projets/${p.id}`,
    })
  }

  // La fabrication en pause faute d'accès (fabrique.mjs, pause_limite) : elle reprend seule.
  const fin = lireReglage(db, "pause_limite", "")
  if (fin && new Date(fin).getTime() > maintenant) {
    const credit = facturationsEnCours(db).length > 0
    const debut = db.prepare("SELECT le FROM journal WHERE type = 'pause' ORDER BY id DESC LIMIT 1").get()
    liste.push({
      groupe: "debloquer", type: "pause", cle: "pause", projet: null,
      titre: `La fabrication est en pause ${jusqua(fin, maintenant)}`,
      detail: `${credit ? "Un accès à l'IA est refusé faute de crédit, les autres sont à leur limite d'usage." : "Les accès à l'IA sont à leur limite d'usage."} Elle reprend seule, sans perdre de tentative.`,
      jusqua: iso(fin), depuis: iso(debut?.le), lien: "#/reglages/integrations",
      action: { type: "lien", libelle: credit ? "Ajouter du crédit ou une clé de secours" : "Ajouter une clé de secours", lien: "#/reglages/integrations", aide: "Une clé de secours évite d'attendre à la prochaine limite." },
    })
  }

  // Le coffre des clés verrouillé (fournisseurs.mjs) : seule la personne qui s'occupe du serveur peut le rouvrir.
  // La clé maîtresse n'est lue qu'au démarrage de l'orchestrateur (config.mjs) : après « secrets.sh axmaril »,
  // il faut le redémarrer. « docker compose up -d » ne le ferait pas : le conteneur tourne déjà.
  let verrouille = false
  try {
    verrouille = Boolean(etatFournisseurs(ctx).verrouille)
  } catch {}
  if (verrouille) {
    liste.push({
      groupe: "debloquer", type: "coffre", cle: "coffre", projet: null,
      titre: "Le coffre des clés est verrouillé",
      detail: "La clé maîtresse d'AXMARIL n'arrive plus : les clés posées dans la console ne servent pas, celles du serveur prennent le relais.",
      depuis: null, lien: "#/reglages/integrations",
      action: { type: "commande", libelle: "À faire sur le serveur", aide: "Vérifier que l'agent AXMARIL tourne, puis, dans le dossier de l'usine :", commandes: ["bash secrets.sh axmaril", "docker compose restart orchestrateur"] },
    })
  }

  // Une fonction arrêtée sans décision ouverte (une décision résolue à moitié, par exemple) : rien ne
  // la relancera seule. Une fonction qui attend sa décision est déjà dans « Décider ».
  // Un délai de grâce de ORPHELINE_MS : la fonction passe « bloquee » avant que son escalade soit écrite
  // (creerEscalade attend GitHub, jusqu'à 3 minutes s'il répond mal), et une décision B laisse la fonction
  // « bloquee » le temps de la fusion. Ni l'un ni l'autre n'est une fonction orpheline.
  const avant = sqlDate(maintenant - ORPHELINE_MS)
  const orphelines = db.prepare(`SELECT t.id, t.cle, t.projet_id, t.maj_le, p.nom FROM taches t JOIN projets p ON p.id = t.projet_id
      WHERE t.statut = 'bloquee' AND p.statut NOT IN ('supprime', 'abandonne', 'arrete', 'reorientation') AND t.maj_le <= ?
      AND NOT EXISTS (SELECT 1 FROM escalades e WHERE e.tache_id = t.id AND e.statut = 'ouverte')
      AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.tache_id = t.id AND d.le > ?) ORDER BY t.id`).all(avant, avant)
  for (const t of orphelines) {
    const derriere = fonctionsDerriere(db.prepare("SELECT cle, statut, depend_de FROM taches WHERE projet_id = ?").all(t.projet_id), t.cle)
    liste.push({
      groupe: "debloquer", type: "tache", cle: `tache:${t.id}`, projet: t.projet_id,
      titre: `${t.nom ?? `Projet ${t.projet_id}`} · ${t.cle} est arrêtée sans décision ouverte`,
      detail: `Rien ne la relancera seule${derriere ? ` : ${pluriel(derriere, "fonction attend", "fonctions attendent")} derrière` : ""}. Change de direction depuis la page du projet.`,
      derriere, depuis: iso(t.maj_le), lien: `#/projets/${t.projet_id}`,
      action: { type: "lien", libelle: "Voir le projet", lien: `#/projets/${t.projet_id}` },
    })
  }

  // Une adresse web personnalisée qui attend son enregistrement (domaines.mjs) : l'enregistrement exact à créer.
  let adresses = []
  try {
    adresses = db.prepare(`SELECT d.hote, d.message, d.demande_le, d.projet_id, p.nom FROM domaines d JOIN projets p ON p.id = d.projet_id
        WHERE d.statut = 'attente_dns' AND p.statut = 'en_production' ORDER BY d.id`).all()
  } catch {} // une base sans table des domaines
  for (const d of adresses) {
    const ipServ = ipConnue(config)
    liste.push({
      groupe: "debloquer", type: "dns", cle: `dns:${d.hote}`, projet: d.projet_id,
      titre: `${d.nom} · ${d.hote} attend son enregistrement`,
      detail: `Crée cet enregistrement chez ton fournisseur de nom de domaine. L'usine vérifie toute seule toutes les 2 minutes${d.message ? ` ; pour l'instant : ${premiereLigne(d.message)}` : ""}.`,
      enregistrement: enregistrementDns(d.hote, ipServ ? [ipServ] : []),
      depuis: iso(d.demande_le), lien: `#/projets/${d.projet_id}`,
      action: { type: "enregistrement" },
    })
  }
  return liste
}

// --- Réparer -----------------------------------------------------------------------------
// Les pannes de l'usine elle-même, d'après le dernier bilan de la surveillance. Les lignes des
// produits n'y sont pas (la sonde les donne, produitsAReparer), ni le résumé des applications.
function usineAReparer(maintenant) {
  const bilan = dernierEtatUsine()
  if (!bilan || maintenant - bilan.le > BILAN_MAX_MS) return []
  return bilan.composants
    .filter((c) => c.etat === "panne" && !c.resume && !c.produit)
    .map((c) => ({ groupe: "reparer", type: "usine", cle: `usine:${c.nom}`, projet: null, service: c.nom, titre: `${c.nom} : en panne`, detail: premiereLigne(c.detail), depuis: null, lien: "#/reglages/etat" }))
}

// Les produits en panne et la sonde, d'après le parc (parcProduits de visibilite.mjs). Un produit « à
// surveiller » n'y est pas : il ne demande rien, sa carte le montre dans Productions.
export function produitsAReparer(parc) {
  const { sonde } = parc
  const base = { groupe: "reparer", type: "sonde", cle: "sonde", projet: null, depuis: sonde.le, lien: "#/reglages/etat" }
  if (sonde.muette) return [{ ...base, titre: "L'état des produits est inconnu", detail: "le serveur n'a pas pu lire l'état des applications à la dernière vérification" }]
  if (sonde.perimee) return [{ ...base, titre: "Les produits ne sont plus vérifiés", detail: "la dernière vérification des applications est trop ancienne : leur état réel est inconnu" }]
  return [...parc.productions, ...parc.apercus].filter((x) => x.etat === "panne").map((x) => ({
    groupe: "reparer", type: "panne", cle: `produit:${x.cle}`, projet: x.projet_id,
    titre: `${x.nom} · ${x.environnement === "apercu" ? "aperçu" : "production"} en panne`, detail: x.raison, depuis: null,
    lien: x.projet_id ? `#/projets/${x.projet_id}` : "#/reglages/etat",
  }))
}

// --- La file, sans les produits ------------------------------------------------------------
// Décider, Débloquer, et les pannes de l'usine ; visibilite.mjs (fileAttente, ceQuiAttend) y ajoute
// les produits et range le tout. maintenant : en millisecondes.
export function elementsAttente(ctx, { raisons = {}, maintenant = Date.now() } = {}) {
  return [...aDecider(ctx, raisons), ...aDebloquer(ctx, maintenant), ...usineAReparer(maintenant)]
}
