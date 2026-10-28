// La recette : les scénarios cachés du persona, joués à la fin, sur le produit fini.
//
// Ces scénarios n'ont jamais été montrés à l'agent qui code (ni écrits dans le dépôt) : il n'a
// pas pu coder « pour le test ». C'est le vérificateur (Codex, une autre famille de modèles)
// qui les joue, dans la peau du persona, sur la branche de base telle qu'elle sera livrée.
// Le résultat va dans le rapport final : l'humain décide (valider, ou corriger d'après la recette).
// Une recette impossible (panne, limite d'usage) ne bloque jamais la livraison.
//
// La même séance note aussi la pyramide de l'expérience (pyramide.mjs), étage par étage :
// c'est elle qui dit si le produit franchit le gouffre. Sans persona, la recette joue le
// rôle de l'utilisateur cible du plan et ne note que la pyramide.
import { RESEAU, executer, ecrireFichier, lireFichier, q } from "./travaux.mjs"
import { extraireJson } from "./analyste.mjs"
import { enregistrer, usagesCodex } from "./couts.mjs"
import { noterLimites, scriptCodex } from "./moteurs.mjs"
import { libererPort, lireProfil } from "./profil.mjs"
import { lirePersona, obtenirPersona } from "./personas.mjs"
import { maj, noter, obtenir, plan as lirePlan } from "./db.mjs"
import { SCHEMA_PYRAMIDE, normaliserPyramide, pyramideEnCorrections, pyramideEnTexte, sensEnTexte, verdictPyramide } from "./pyramide.mjs"

function consigne(projet, persona) {
  const f = persona.fiche ?? {}
  const sens = lirePlan(projet)?.sens
  const scenarios = persona.scenarios ?? []
  return `Tu fais la RECETTE d'un logiciel terminé, dans la peau de son utilisateur cible. Tu es exigeant, concret, et tu ne juges que ce que tu observes.

Le produit « ${projet.nom} » tourne sur http://localhost:4100. Le code est dans le dossier courant (lis-le seulement pour trouver les écrans et les routes).

Tu es « ${persona.nom} » : ${f.resume ?? ""}
${f.problemes?.length ? `Tes problèmes : ${f.problemes.map((p) => p.probleme).join(" ; ")}.` : ""}
${f.objections?.length ? `Ce qui te ferait renoncer : ${f.objections.join(" ; ")}.` : ""}

${scenarios.length ? `Joue chacun de ces scénarios pour de vrai, dans l'application en marche (Playwright : \`const { chromium } = require('playwright')\`, Chromium est installé ; curl pour l'API) :
${scenarios.map((s, i) => `${i + 1}. ${s.titre}
   Situation : ${s.situation}
   ${s.etapes?.length ? `Étapes probables : ${s.etapes.join(" → ")}\n   ` : ""}Attendu : ${s.attendu}`).join("\n")}` : `Pas de scénario imposé : découvre le produit comme un nouvel utilisateur, dans l'application en marche (Playwright : \`const { chromium } = require('playwright')\`, Chromium est installé ; curl pour l'API). Fais ses parcours principaux de bout en bout, sur ordinateur (1440) et sur mobile (390).`}

Puis note la pyramide de l'expérience du produit, étage par étage, de 0 à 10, d'après ce que tu as vécu (pas d'après le code) :
${pyramideEnTexte()}
${sens ? `Pour l'étage « Qui a du sens », juge la promesse décidée à partir du persona :
${sensEnTexte(sens)}
L'as-tu ressentie, au moment prévu, et la preuve est-elle à l'écran ?
` : ""}Un étage est tenu à partir de 7. Sois sévère : 7 veut dire « un utilisateur exigeant serait satisfait ». Pour chaque étage, « observe » dit ce que tu as constaté (une phrase), et « pour_monter » donne LA modification concrète (un écran, ce qu'on change) qui ferait le plus monter la note.

Règles :
${scenarios.length ? `- Un scénario est « tenu » seulement si tu as obtenu le résultat attendu, comme le persona l'obtiendrait (sans connaître le code, sans contourner l'interface).
- « observe » dit ce que tu as réellement vu, en une ou deux phrases ; « ecart » dit ce qui manque ou gêne le persona (vide si tenu).
- Enregistre une capture PNG par scénario dans /tmp/sorties/recette/captures/ (scenario-1.png, …), largeur 1440.` : "- Enregistre 2 à 4 captures PNG des moments clés dans /tmp/sorties/recette/captures/, largeur 1440."}

Réponds UNIQUEMENT par ce JSON :
{"scenarios": [${scenarios.length ? `{"titre": "…", "tenu": true, "observe": "…", "ecart": ""}` : ""}], ${SCHEMA_PYRAMIDE}, "resume": "une phrase : l'utilisateur serait-il convaincu ?"}`
}

// Joue la recette sur un sha de la branche de base. Renvoie le résultat (aussi gardé en base).
export async function jouerRecette(ctx, projetId, sha) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const fiche = projet.persona_id ? lirePersona(obtenirPersona(db, projet.persona_id)) : null
  // Sans persona (ou sans scénario), l'utilisateur cible décrit par le plan : seule la pyramide est notée.
  const persona = fiche?.scenarios?.length ? fiche : { nom: fiche?.nom ?? "l'utilisateur cible", fiche: fiche?.fiche ?? { resume: lirePlan(projet)?.resume ?? projet.prompt }, scenarios: [] }
  const nomPersona = fiche?.scenarios?.length ? persona.nom : null
  const profil = lireProfil(projet)
  const serveur = config.verificateur.url
  const jeton = config.secrets.worker
  const annonce = nomPersona ? `les ${persona.scenarios.length} scénarios cachés du persona « ${persona.nom} », et note la pyramide de l'expérience` : "le produit fini comme un nouvel utilisateur, et note la pyramide de l'expérience"
  noter(db, { projet: projetId, type: "recette", message: `Recette sur ${sha.slice(0, 7)} : le vérificateur joue ${annonce}` })
  await ctx.notifier.progres(projet, `🎭 Recette : le vérificateur joue ${annonce}`).catch(() => {})

  let resultat
  try {
    const clone = await executer(serveur, jeton, [
      "set -eo pipefail",
      RESEAU,
      "rm -rf /travail/recette /tmp/sorties/recette && mkdir -p /travail/recette /tmp/sorties/recette/captures && cd /travail/recette",
      `cloner "https://x-access-token:$JETON@github.com/${projet.depot}.git" depot 2>&1 | sed "s/$JETON/***/g"`,
      `cd depot && git remote set-url origin https://github.com/${projet.depot}.git && git checkout -q ${q(sha)}`,
      "echo '@@ CLONE_OK'",
    ].join("\n"), { env: { JETON: config.secrets.github }, minutes: 5 })
    if (!("CLONE_OK" in clone.marqueurs)) throw new Error(`clone impossible : ${clone.journal.slice(-300)}`)
    const r = await executer(serveur, jeton, [
      "cd /travail/recette/depot",
      ecrireFichier("/tmp/sorties/recette/consigne.md", consigne(projet, persona)),
      `bash -c ${q(profil.installer)} > /tmp/sorties/recette/install.log 2>&1 || true`,
      `bash -c ${q(profil.construire)} > /tmp/sorties/recette/build.log 2>&1 || true`,
      `export PORT=4100 DATA_DIR=/tmp/recette-data DEMO=1 PUBLIC_URL=http://localhost:4100 DEMO_VITESSE_HORLOGE=${Number(config.demo?.vitesse_horloge ?? 1)}`,
      ...((config.demo?.services ?? []).includes("mailpit") ? ["export SMTP_HOST=mailpit SMTP_PORT=1025"] : []),
      "rm -rf $DATA_DIR",
      libererPort(4100),
      `(setsid bash -c ${q(profil.demarrer)} > /tmp/sorties/recette/app.log 2>&1 &)`,
      "for i in $(seq 1 40); do if curl -sf http://localhost:4100/api/health > /dev/null; then echo '@@ APP_STARTED'; break; fi; sleep 2; done",
      "if curl -sf http://localhost:4100/api/health > /dev/null; then",
      scriptCodex(ctx, { args: `--json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --output-last-message /tmp/sorties/recette/verdict.txt -`, entree: "/tmp/sorties/recette/consigne.md", journal: "/tmp/sorties/recette/codex.log", marqueur: "RECETTE_CODE" }),
      "fi",
      "echo \"@@ CAPTURES $(cd /tmp/sorties/recette/captures 2>/dev/null && ls *.png 2>/dev/null | tr '\\n' ' ')\"",
      libererPort(4100),
    ].join("\n"), { minutes: 40 })
    const acces = noterLimites(ctx, "codex", r.marqueurs)
    if (acces.epuise) throw new Error("Codex est à sa limite d'usage")
    if (!("APP_STARTED" in r.marqueurs)) throw new Error("le produit ne démarre pas pour la recette")
    if ("RECETTE_CODE" in r.marqueurs) enregistrer(db, { projet: projetId, role: "recette", moteur: "codex", usages: usagesCodex(await lireFichier(serveur, jeton, "/tmp/sorties/recette/codex.log"), null, config), duree_s: r.duree_s ?? 0 })
    const v = extraireJson(String((await lireFichier(serveur, jeton, "/tmp/sorties/recette/verdict.txt")) ?? ""))
    const scenarios = persona.scenarios.map((s, i) => {
      const x = (v.scenarios ?? [])[i] ?? {}
      return { titre: s.titre, tenu: x.tenu === true, observe: String(x.observe ?? "non joué").slice(0, 600), ecart: String(x.ecart ?? "").slice(0, 600) }
    })
    resultat = { sha, le: new Date().toISOString(), persona: nomPersona, scenarios, tenus: scenarios.filter((s) => s.tenu).length, total: scenarios.length, pyramide: normaliserPyramide(v.pyramide), resume: String(v.resume ?? "").slice(0, 400) }
  } catch (error) {
    resultat = { sha, le: new Date().toISOString(), persona: nomPersona, erreur: String(error.message).slice(0, 500), scenarios: [], tenus: 0, total: persona.scenarios.length }
  }
  maj(db, "projets", projetId, { recette: JSON.stringify(resultat) })
  noter(db, { projet: projetId, type: "recette", message: resultat.erreur ? `Recette impossible : ${resultat.erreur}` : `Recette : ${resultat.total ? `${resultat.tenus}/${resultat.total} scénario(s) tenu(s). ` : ""}${verdictPyramide(resultat.pyramide)} ${resultat.resume}`.trim() })
  return resultat
}

export const lireRecette = (projet) => {
  try {
    return projet?.recette ? JSON.parse(projet.recette) : null
  } catch {
    return null
  }
}

// Les écarts de la recette, en demande de corrections (ce qu'on a observé, pas le scénario entier),
// puis les étages de la pyramide à faire monter.
export function ecartsEnCorrections(recette) {
  const ecarts = (recette?.scenarios ?? []).filter((s) => !s.tenu)
  const parties = []
  if (ecarts.length) {
    parties.push([
      `La recette du persona « ${recette.persona} » a relevé ${ecarts.length} écart(s) sur le produit fini. Corrige-les du point de vue du persona (ICP.md), sans casser ce qui marche :`,
      ...ecarts.map((s) => `- ${s.titre} : ${s.ecart || s.observe}`),
    ].join("\n"))
  }
  const pyramide = pyramideEnCorrections(recette?.pyramide)
  if (pyramide) parties.push(pyramide)
  return parties.join("\n\n")
}

// Le nombre de points à corriger : les écarts, et les étages de la pyramide à faire monter.
export const pointsACorriger = (recette) => ecartsEnCorrections(recette).split("\n").filter((l) => l.startsWith("- ")).length
