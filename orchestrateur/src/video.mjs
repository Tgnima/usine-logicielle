// La vidéo de présentation d'un projet, générée à la demande (bouton de la console) :
// le nom, le besoin, les fonctionnalités avec les vraies captures d'écran, les chiffres,
// l'adresse du produit, aux couleurs de son brief de design. Aucun appel à un modèle :
// tout vient du plan et de ce que l'usine a déjà mesuré. Le rendu (Chromium + ffmpeg)
// se fait dans le vérificateur, quand il est libre ; la fabrication n'est jamais bloquée.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { adresses } from "./config.mjs"
import { noter, obtenir, plan as lirePlan, taches } from "./db.mjs"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { executer, ecrireFichier, lireFichierBinaire } from "./travaux.mjs"

const GABARIT = fileURLToPath(new URL("../video/gabarit.html", import.meta.url))
const RENDU = fileURLToPath(new URL("../video/rendre.cjs", import.meta.url))
const IMAGE_MAX = 2_500_000 // octets ; au-delà, la capture n'est pas embarquée

export const fichierVideo = (config, projetId) => join(config.dataDir, "videos", `${projetId}.mp4`)

export function etatVideo(ctx, projetId) {
  let e = null
  try {
    e = JSON.parse(lireReglage(ctx.db, `video_${projetId}`, "null"))
  } catch {}
  const f = fichierVideo(ctx.config, projetId)
  return { ...(e ?? { etat: existsSync(f) ? "prete" : "aucune" }), fichier: existsSync(f) ? { taille: statSync(f).size, le: statSync(f).mtime.toISOString() } : null }
}
const ecrireEtat = (ctx, projetId, e) => ecrireReglage(ctx.db, `video_${projetId}`, JSON.stringify({ ...e, le: new Date().toISOString() }))

// Les captures d'une tâche (de préférence sur ordinateur), les plus récentes d'abord.
function capturesTache(config, projetId, cle) {
  const d = join(config.dataDir, "captures", String(projetId), cle)
  if (!existsSync(d)) return []
  return readdirSync(d).filter((f) => /\.png$/.test(f))
    .map((f) => ({ chemin: join(d, f), bureau: /bureau|desktop|1440/i.test(f), date: statSync(join(d, f)).mtimeMs, taille: statSync(join(d, f)).size }))
    .filter((c) => c.taille <= IMAGE_MAX)
    .sort((a, b) => Number(b.bureau) - Number(a.bureau) || b.date - a.date)
}

// Les couleurs du brief de design (palette du plan), sinon celles de l'usine.
function couleurs(plan) {
  const pal = plan?.design?.palette ?? {}
  const ok = (v) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined)
  const c = { accent: ok(pal.accent) ?? ok(pal.primaire), fond: ok(pal.fond), surface: ok(pal.surface), encre: ok(pal.texte), doux: ok(pal.doux) }
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v))
}

// Les données de la vidéo, tirées du projet (exportée pour les tests).
export function donneesVideo(ctx, projetId) {
  const { db, config } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (!projet) throw new Error("Projet introuvable.")
  const plan = lirePlan(projet)
  if (!plan?.lots?.length) throw new Error("Ce projet n'a pas encore de plan : rien à présenter.")
  const t = taches(db, projetId)
  // Les fonctionnalités : les lots du plan d'origine (les lots de corrections ne sont pas des fonctionnalités).
  const lots = plan.lots.map((l, i) => ({ ...l, numero: i + 1 })).filter((l) => !/^corrections?\b/i.test(l.nom)).slice(0, 4)
  const dejaPrises = new Set()
  const lotsVideo = lots.map((l) => {
    const cles = t.filter((x) => x.lot === l.numero && x.statut === "fusionnee").map((x) => x.cle)
    const capture = cles.flatMap((c) => capturesTache(config, projetId, c)).find((c) => !dejaPrises.has(c.chemin))
    if (capture) dejaPrises.add(capture.chemin)
    return {
      nom: l.nom,
      objectif: l.objectif ?? "",
      taches: (l.taches ?? []).map((x) => x.titre).slice(0, 4),
      capture: capture ? `data:image/png;base64,${readFileSync(capture.chemin).toString("base64")}` : null,
    }
  })
  const calcul = db.prepare("SELECT COALESCE(SUM(duree_s), 0) AS s FROM consommations WHERE projet_id = ?").get(projetId)?.s ?? 0
  const heures = calcul / 3600
  const a = projet.slug ? adresses(config, projet.slug) : null
  return {
    nom: projet.nom ?? plan.nom,
    resume: plan.resume ?? "",
    demande: String(projet.prompt ?? "").replace(/\n+\(Type de produit souhaité[^)]*\)\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 260),
    couleurs: couleurs(plan),
    lots: lotsVideo,
    chiffres: {
      lots: plan.lots.length,
      taches: t.filter((x) => x.statut === "fusionnee").length,
      tests: projet.plancher_tests || null,
      duree: heures >= 1 ? `${Math.round(heures)} h` : calcul > 0 ? `${Math.max(1, Math.round(calcul / 60))} min` : null,
    },
    adresse: projet.statut === "en_production" && a ? a.production : a && projet.lot_livre ? a.apercu : "",
  }
}

// La page de la vidéo : le gabarit avec les données du projet (sans risque d'injection).
export function pageVideo(donnees) {
  // « < » échappé : le JSON ne peut pas fermer la balise <script> (U+2028/2029 sont permis en JS moderne).
  const json = JSON.stringify(donnees).replaceAll("<", "\\u003c")
  return readFileSync(GABARIT, "utf8").replace("<!-- DONNEES -->", `<script>window.DONNEES = ${json}</script>`)
}

// Le bouton de la console : lance la génération (en tâche de fond) et répond tout de suite.
export function genererVideo(ctx, projetId, par) {
  const e = etatVideo(ctx, projetId)
  if (e.etat === "en_cours" && Date.now() - new Date(e.le).getTime() < 90 * 60_000) return { ok: false, message: "Une vidéo est déjà en cours de génération pour ce projet." }
  const donnees = donneesVideo(ctx, projetId) // lève une erreur claire si le projet n'est pas prêt
  ecrireEtat(ctx, projetId, { etat: "en_cours", par })
  noter(ctx.db, { projet: projetId, type: "video", message: `Vidéo de présentation demandée par ${par}` })
  ;(async () => {
    const { config } = ctx
    const r = await executer(config.verificateur.url, config.secrets.worker, [
      "set -e",
      "rm -rf /tmp/sorties/video && mkdir -p /tmp/sorties/video && cd /tmp/sorties/video",
      ecrireFichier("/tmp/sorties/video/film.html", pageVideo(donnees)),
      ecrireFichier("/tmp/sorties/video/rendre.cjs", readFileSync(RENDU, "utf8")),
      "node rendre.cjs /tmp/sorties/video",
    ].join("\n"), { minutes: 25 })
    if (!("VIDEO_OK" in r.marqueurs)) throw new Error(r.marqueurs.VIDEO_ERREUR || r.journal.split("\n").slice(-4).join(" ").slice(0, 300) || "rendu impossible")
    const contenu = await lireFichierBinaire(config.verificateur.url, config.secrets.worker, "/tmp/sorties/video/film.mp4")
    if (!contenu?.length) throw new Error("vidéo introuvable après le rendu")
    mkdirSync(join(config.dataDir, "videos"), { recursive: true })
    writeFileSync(fichierVideo(config, projetId), contenu)
    ecrireEtat(ctx, projetId, { etat: "prete", par })
    noter(ctx.db, { projet: projetId, type: "video", message: `Vidéo de présentation prête (${Math.round(contenu.length / 1024)} Ko)` })
  })().catch((error) => {
    console.error("Vidéo :", error.message)
    ecrireEtat(ctx, projetId, { etat: "erreur", par, message: error.message.slice(0, 300) })
    noter(ctx.db, { projet: projetId, type: "erreur", message: `Vidéo de présentation : ${error.message.slice(0, 300)}` })
  })
  return { ok: true, message: "Génération lancée : la vidéo arrive ici dans quelques minutes." }
}
