// Le cycle de vie, pour tenir sur un petit serveur :
//   - un aperçu vit `apercus.duree_vie_jours` (7 par défaut) après la dernière activité
//     du projet ; un rappel 24 h avant (Prolonger / Garder / Retirer maintenant) ;
//   - un projet peut être supprimé : aperçu et production retirés ; le code reste sur
//     GitHub et les données de production restent sur le serveur (jamais supprimées) ;
//   - la base de l'usine est sauvegardée chaque jour (14 jours gardés) ;
//   - la mise à jour de l'usine : pause après la tâche en cours, puis le déployeur la fait.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { maj, noter, obtenir } from "./db.mjs"
import { ecrireEtat, supprimerEtat } from "./github.mjs"
import { arreter, reprendre } from "./pipeline.mjs"
import { lireSanteServeur } from "./sante.mjs"

const ACTIFS = ["analyse", "questions", "plan_a_valider", "creation", "fabrication", "corrections", "bloque", "mise_en_production"]
const jours = (config) => Number(config.apercus?.duree_vie_jours ?? 7)
const dans = (j) => new Date(Date.now() + j * 86_400_000).toISOString()

export function ouvrirCycle(db) {
  const colonnes = new Set(db.prepare("PRAGMA table_info(projets)").all().map((c) => c.name))
  for (const [nom, def] of [["apercu_expire_le", "TEXT"], ["apercu_garde", "INTEGER NOT NULL DEFAULT 0"], ["apercu_rappel", "INTEGER NOT NULL DEFAULT 0"], ["apercu_retire", "INTEGER NOT NULL DEFAULT 0"]]) {
    if (!colonnes.has(nom)) db.exec(`ALTER TABLE projets ADD COLUMN ${nom} ${def}`)
  }
  if (!colonnes.has("finition_faite")) db.exec("ALTER TABLE projets ADD COLUMN finition_faite INTEGER NOT NULL DEFAULT 0")
  const colonnesTaches = new Set(db.prepare("PRAGMA table_info(taches)").all().map((c) => c.name))
  if (!colonnesTaches.has("design")) db.exec("ALTER TABLE taches ADD COLUMN design TEXT") // note et remarques du relecteur design
}

// Après chaque aperçu livré : le compte à rebours repart.
export function apercuLivre(ctx, projetId) {
  maj(ctx.db, "projets", projetId, { apercu_expire_le: dans(jours(ctx.config)), apercu_rappel: 0, apercu_retire: 0 })
}

export function decrireApercu(projet) {
  if (!projet.lot_livre) return "—"
  if (projet.apercu_retire) return "retiré"
  if (projet.apercu_garde) return "gardé"
  if (!projet.apercu_expire_le) return "—"
  const reste = (new Date(projet.apercu_expire_le).getTime() - Date.now()) / 86_400_000
  return reste < 1 ? `expire dans ${Math.max(1, Math.round(reste * 24))} h` : `expire dans ${Math.round(reste)} j`
}

export async function prolongerApercu(ctx, projetId, par) {
  maj(ctx.db, "projets", projetId, { apercu_expire_le: dans(jours(ctx.config)), apercu_rappel: 0, apercu_garde: 0 })
  noter(ctx.db, { projet: projetId, type: "cycle", message: `Aperçu prolongé de ${jours(ctx.config)} jours par ${par}` })
  return { ok: true, message: `Aperçu prolongé de ${jours(ctx.config)} jours.` }
}

export async function garderApercu(ctx, projetId, par) {
  maj(ctx.db, "projets", projetId, { apercu_garde: 1 })
  noter(ctx.db, { projet: projetId, type: "cycle", message: `Aperçu gardé sans limite par ${par}` })
  return { ok: true, message: "Aperçu gardé sans limite de durée." }
}

export async function retirerApercu(ctx, projetId, par) {
  const projet = obtenir(ctx.db, "projets", projetId)
  if (!projet?.slug) return { ok: false, message: "Projet inconnu." }
  await supprimerEtat(ctx.config, `apercus/${projet.slug}.json`, `Aperçu ${projet.slug} retiré (${par})`)
  maj(ctx.db, "projets", projetId, { apercu_retire: 1, apercu_garde: 0 })
  noter(ctx.db, { projet: projetId, type: "cycle", message: `Aperçu retiré par ${par}` })
  await ctx.notifier.etape(projet, `:broom: Aperçu de *${projet.nom}* retiré (${par}) : place libérée sur le serveur. Le code reste sur GitHub ; un nouveau lot livré le remettra en ligne.`)
  return { ok: true, message: "Aperçu retiré." }
}

// Supprimer un projet : tout ce qui tourne s'arrête ; le code et les données de production restent.
export async function supprimerProjet(ctx, projetId, par) {
  const { db, config } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (!projet) return { ok: false, message: "Projet inconnu." }
  if (["creation", "fabrication", "corrections", "mise_en_production"].includes(projet.statut)) return { ok: false, message: "Le projet est en cours de fabrication : attends la fin du lot, ou arrête l'usine (/usine stop)." }
  if (projet.slug) {
    await supprimerEtat(config, `apercus/${projet.slug}.json`, `Projet ${projet.slug} supprimé (${par})`)
    await supprimerEtat(config, `production/${projet.slug}.json`, `Projet ${projet.slug} supprimé (${par})`)
  }
  maj(db, "projets", projetId, { statut: "supprime", apercu_retire: 1 })
  noter(db, { projet: projetId, type: "cycle", message: `Projet supprimé par ${par}` })
  await ctx.notifier.etape(projet, `:wastebasket: *${projet.nom ?? "Projet"}* supprimé par ${par} : aperçu et production arrêtés, place libérée. Le code reste sur GitHub${projet.depot ? ` (${projet.depot})` : ""} et les données de production sont gardées sur le serveur.`)
  return { ok: true, message: "Projet supprimé." }
}

// Toutes les 30 minutes : rappels et retraits des aperçus.
async function tourApercus(ctx) {
  const { db, config } = ctx
  for (const p of db.prepare("SELECT * FROM projets WHERE lot_livre > 0 AND apercu_retire = 0 AND statut NOT IN ('abandonne', 'supprime')").all()) {
    if (p.apercu_garde) continue
    // Un projet en activité garde son aperçu : le compte à rebours repart.
    if (ACTIFS.includes(p.statut) || !p.apercu_expire_le) {
      maj(db, "projets", p.id, { apercu_expire_le: dans(jours(config)), apercu_rappel: 0 })
      continue
    }
    const reste = new Date(p.apercu_expire_le).getTime() - Date.now()
    if (reste <= 0) {
      await retirerApercu(ctx, p.id, "l'usine (durée de vie écoulée)")
      continue
    }
    if (reste < 24 * 3600_000 && !p.apercu_rappel) {
      maj(db, "projets", p.id, { apercu_rappel: 1 })
      await ctx.notifier.etape(p, `:hourglass: L'aperçu de *${p.nom}* sera retiré dans moins de 24 h (durée de vie de ${jours(config)} jours sans activité), pour garder de la place sur le serveur. La production n'est pas concernée.`, [
        { texte: `Prolonger de ${jours(config)} jours`, action: "apercu_prolonger", valeur: p.id },
        { texte: "Garder sans limite", action: "apercu_garder", valeur: p.id },
        { texte: "Retirer maintenant", action: "apercu_retirer", valeur: p.id },
      ])
    }
  }
}

// Chaque jour : une copie de la base de l'usine (14 jours gardés).
function sauvegarderBase(ctx) {
  const dossier = join(ctx.config.dataDir, "sauvegardes")
  mkdirSync(dossier, { recursive: true })
  const fichier = join(dossier, `usine-${new Date().toISOString().slice(0, 10)}.db`)
  if (existsSync(fichier)) return
  ctx.db.exec(`VACUUM INTO '${fichier.replace(/'/g, "''")}'`)
  const anciennes = readdirSync(dossier).filter((f) => /^usine-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(14)
  for (const f of anciennes) unlinkSync(join(dossier, f))
  console.log(`Sauvegarde de la base : ${fichier}`)
}

// --- La mise à jour de l'usine -------------------------------------------------------------
const marqueur = (ctx) => join(ctx.config.dataDir, "mise-a-jour.json")

export async function mettreAJourUsine(ctx, par) {
  const s = lireSanteServeur(ctx.config)
  if (!s?.mise_a_jour?.disponible) return { ok: false, message: "L'usine est déjà à jour." }
  if (existsSync(marqueur(ctx))) return { ok: false, message: "Une mise à jour est déjà en cours." }
  writeFileSync(marqueur(ctx), JSON.stringify({ par, le: new Date().toISOString(), version_avant: s.mise_a_jour.version, commits: s.mise_a_jour.commits }))
  arreter(ctx, `mise à jour (${par})`)
  await ctx.notifier.alerte(`:arrows_counterclockwise: *Mise à jour de l'usine* demandée par ${par} (${s.mise_a_jour.disponible} changement(s)). J'attends la fin de la tâche en cours, puis l'usine redémarre ; elle reprend seule.`)
  // En tâche de fond : attendre qu'aucune tâche ne tourne, puis demander la mise à jour au déployeur.
  ;(async () => {
    const limite = Date.now() + 90 * 60_000
    while (Date.now() < limite && ctx.db.prepare("SELECT 1 FROM taches WHERE statut IN ('en_cours', 'verification')").get()) await new Promise((r) => setTimeout(r, 15_000))
    await ecrireEtat(ctx.config, "usine/mise-a-jour.json", { demande_le: new Date().toISOString(), par }, { message: `Mise à jour de l'usine (${par})` })
  })().catch(async (e) => {
    rmSync(marqueur(ctx), { force: true })
    reprendre(ctx)
    await ctx.notifier.alerte(`:x: La mise à jour n'a pas pu être lancée : ${e.message}. L'usine reprend.`)
  })
  return { ok: true, message: "Mise à jour lancée : l'usine termine sa tâche en cours, puis redémarre." }
}

// Au démarrage : une mise à jour vient de se faire ? On reprend et on l'annonce.
async function finMiseAJour(ctx) {
  if (!existsSync(marqueur(ctx))) return
  const m = JSON.parse(readFileSync(marqueur(ctx), "utf8"))
  // Le marqueur est posé avant la demande : on n'annonce la fin que si la version a changé.
  const s = lireSanteServeur(ctx.config)
  const version = s?.mise_a_jour?.version
  const derniere = s?.mise_a_jour?.derniere
  // Le déployeur a constaté la fin de CETTE mise à jour (lancée après notre demande).
  if (derniere?.terminee_le && new Date(derniere.terminee_le) > new Date(m.le)) {
    rmSync(marqueur(ctx), { force: true })
    reprendre(ctx)
    if (derniere.reussie) {
      await ctx.notifier.alerte(`:white_check_mark: *Usine mise à jour* (version ${version}), elle reprend.\n${(m.commits ?? []).slice(0, 10).map((c) => `• ${c.replace(/^\w+ /, "")}`).join("\n")}`)
    } else {
      await ctx.notifier.alerte(`:x: *La mise à jour de l'usine a échoué* : rien n'a été redémarré, l'usine reprend dans sa version actuelle (${version}).\n\`\`\`${String(derniere.journal ?? "").slice(-1200)}\`\`\``)
    }
    return
  }
  if (!version || version === m.version_avant) {
    // Rien n'a changé au bout de 2 heures : la mise à jour a échoué, l'usine reprend telle quelle.
    if (Date.now() - new Date(m.le).getTime() > 2 * 3600_000) {
      rmSync(marqueur(ctx), { force: true })
      reprendre(ctx)
      await ctx.notifier.alerte(":x: *La mise à jour de l'usine n'a pas abouti* (la version n'a pas changé en 2 heures). L'usine reprend dans sa version actuelle ; le journal du conteneur `usine-mise-a-jour` dit pourquoi.")
    }
    return
  }
  rmSync(marqueur(ctx), { force: true })
  reprendre(ctx)
  await ctx.notifier.alerte(`:white_check_mark: *Usine mise à jour* (version ${version}), l'usine reprend.\n${(m.commits ?? []).slice(0, 10).map((c) => `• ${c.replace(/^\w+ /, "")}`).join("\n")}`)
}

export function demarrerCycle(ctx) {
  ouvrirCycle(ctx.db)
  const apercus = () => tourApercus(ctx).catch((e) => console.error("Cycle des aperçus :", e.message))
  setTimeout(apercus, 60_000)
  setInterval(apercus, 30 * 60_000)
  const base = () => {
    try {
      sauvegarderBase(ctx)
    } catch (e) {
      console.error("Sauvegarde de la base :", e.message)
    }
  }
  base()
  setInterval(base, 3600_000)
  // La fin d'une mise à jour : le déployeur met à jour la version quelques secondes après le redémarrage.
  const fin = () => finMiseAJour(ctx).catch((e) => console.error("Fin de mise à jour :", e.message))
  setTimeout(fin, 60_000)
  setInterval(fin, 60_000)
}
