// La recette : les scénarios cachés du persona, joués à la fin, sur le produit fini.
//
// Ces scénarios n'ont jamais été montrés à l'agent qui code (ni écrits dans le dépôt) : il n'a
// pas pu coder « pour le test ». C'est le vérificateur (Codex, une autre famille de modèles)
// qui les joue, dans la peau du persona, sur la branche de base telle qu'elle sera livrée.
// Le résultat va dans le rapport final : l'humain décide (valider, ou corriger d'après la recette).
// Une recette impossible (panne, limite d'usage) ne bloque jamais la livraison.
import { RESEAU, executer, ecrireFichier, lireFichier, q } from "./travaux.mjs"
import { extraireJson } from "./analyste.mjs"
import { enregistrer, usagesCodex } from "./couts.mjs"
import { noterLimites, scriptCodex } from "./moteurs.mjs"
import { libererPort, lireProfil } from "./profil.mjs"
import { lirePersona, obtenirPersona } from "./personas.mjs"
import { maj, noter, obtenir } from "./db.mjs"

function consigne(projet, persona) {
  const f = persona.fiche ?? {}
  return `Tu fais la RECETTE d'un logiciel terminé, dans la peau de son utilisateur cible. Tu es exigeant, concret, et tu ne juges que ce que tu observes.

Le produit « ${projet.nom} » tourne sur http://localhost:4100. Le code est dans le dossier courant (lis-le seulement pour trouver les écrans et les routes).

Tu es « ${persona.nom} » : ${f.resume ?? ""}
${f.problemes?.length ? `Tes problèmes : ${f.problemes.map((p) => p.probleme).join(" ; ")}.` : ""}
${f.objections?.length ? `Ce qui te ferait renoncer : ${f.objections.join(" ; ")}.` : ""}

Joue chacun de ces scénarios pour de vrai, dans l'application en marche (Playwright : \`const { chromium } = require('playwright')\`, Chromium est installé ; curl pour l'API) :
${persona.scenarios.map((s, i) => `${i + 1}. ${s.titre}
   Situation : ${s.situation}
   ${s.etapes?.length ? `Étapes probables : ${s.etapes.join(" → ")}\n   ` : ""}Attendu : ${s.attendu}`).join("\n")}

Règles :
- Un scénario est « tenu » seulement si tu as obtenu le résultat attendu, comme le persona l'obtiendrait (sans connaître le code, sans contourner l'interface).
- « observe » dit ce que tu as réellement vu, en une ou deux phrases ; « ecart » dit ce qui manque ou gêne le persona (vide si tenu).
- Enregistre une capture PNG par scénario dans /tmp/sorties/recette/captures/ (scenario-1.png, …), largeur 1440.

Réponds UNIQUEMENT par ce JSON :
{"scenarios": [{"titre": "…", "tenu": true, "observe": "…", "ecart": ""}], "resume": "une phrase : le persona serait-il convaincu ?"}`
}

// Joue la recette sur un sha de la branche de base. Renvoie le résultat (aussi gardé en base).
export async function jouerRecette(ctx, projetId, sha) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const persona = projet.persona_id ? lirePersona(obtenirPersona(db, projet.persona_id)) : null
  if (!persona?.scenarios?.length) return null
  const profil = lireProfil(projet)
  const serveur = config.verificateur.url
  const jeton = config.secrets.worker
  noter(db, { projet: projetId, type: "recette", message: `Recette : ${persona.scenarios.length} scénario(s) caché(s) du persona « ${persona.nom} » joués sur ${sha.slice(0, 7)}` })
  await ctx.notifier.progres(projet, `🎭 Recette : le vérificateur joue les ${persona.scenarios.length} scénarios cachés du persona « ${persona.nom} » sur le produit fini`).catch(() => {})

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
      scriptCodex(ctx, { args: `--json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --output-last-message /tmp/sorties/recette/verdict.txt "$(cat /tmp/sorties/recette/consigne.md)"`, journal: "/tmp/sorties/recette/codex.log", marqueur: "RECETTE_CODE" }),
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
    resultat = { sha, le: new Date().toISOString(), persona: persona.nom, scenarios, tenus: scenarios.filter((s) => s.tenu).length, total: scenarios.length, resume: String(v.resume ?? "").slice(0, 400) }
  } catch (error) {
    resultat = { sha, le: new Date().toISOString(), persona: persona.nom, erreur: String(error.message).slice(0, 500), scenarios: [], tenus: 0, total: persona.scenarios.length }
  }
  maj(db, "projets", projetId, { recette: JSON.stringify(resultat) })
  noter(db, { projet: projetId, type: "recette", message: resultat.erreur ? `Recette impossible : ${resultat.erreur}` : `Recette : ${resultat.tenus}/${resultat.total} scénario(s) tenu(s). ${resultat.resume}` })
  return resultat
}

export const lireRecette = (projet) => {
  try {
    return projet?.recette ? JSON.parse(projet.recette) : null
  } catch {
    return null
  }
}

// Les écarts de la recette, en demande de corrections (ce qu'on a observé, pas le scénario entier).
export function ecartsEnCorrections(recette) {
  const ecarts = (recette?.scenarios ?? []).filter((s) => !s.tenu)
  if (!ecarts.length) return ""
  return [
    `La recette du persona « ${recette.persona} » a relevé ${ecarts.length} écart(s) sur le produit fini. Corrige-les du point de vue du persona (ICP.md), sans casser ce qui marche :`,
    ...ecarts.map((s) => `- ${s.titre} : ${s.ecart || s.observe}`),
  ].join("\n")
}
