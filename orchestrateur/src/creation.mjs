// Après la validation du plan : créer le dépôt du produit à partir de la brique (ou reprendre
// un dépôt existant), vérifier que le socle passe, puis ouvrir une issue par tâche.
import { creerDepot, creerEtiquettes, creerIssue, ecrireFichierDepot } from "./github.mjs"
import { RESEAU, executer, ecrireFichier, q } from "./travaux.mjs"
import { maj, noter, obtenir, plan as lirePlan } from "./db.mjs"
import { planEnMarkdown } from "./analyste.mjs"
import { designEnMarkdown, jetonsCss } from "./design.mjs"
import { scriptPieces } from "./pieces.mjs"
import { COMPTER_TESTS, brancheDeBase, lireProfil } from "./profil.mjs"
import { icpEnMarkdown, lirePersona, missionEnMarkdown, obtenirPersona } from "./personas.mjs"
import { brancheIntegration, inventaireEnMarkdown, lireSocle } from "./reprise.mjs"

export { COMPTER_TESTS }

export const ETIQUETTES = [
  ["usine:attente", "c5def5", "Tâche planifiée, en attente de ses dépendances"],
  ["usine:en-cours", "1d76db", "Un agent y travaille"],
  ["usine:verification", "fbca04", "Le vérificateur indépendant la teste"],
  ["usine:fusionnee", "0e8a16", "Vérifiée et fusionnée"],
  ["usine:bloquant", "b60205", "L'usine a besoin d'une décision humaine"],
  ["usine:abandonnee", "cccccc", "Abandonnée"],
]

// Le persona d'un projet (null s'il n'en a pas).
const personaDu = (db, projet) => (projet.persona_id ? lirePersona(obtenirPersona(db, projet.persona_id)) : null)

// Le cadre écrit dans chaque dépôt : MISSION.md (le cap, protégé) et ICP.md (le persona, protégé).
// Les scénarios cachés du persona n'y sont JAMAIS : ils restent dans l'usine.
function scriptCadre(plan, persona, options) {
  return [
    ecrireFichier("MISSION.md", missionEnMarkdown(plan, { persona, ...options })),
    ...(persona ? [ecrireFichier("ICP.md", icpEnMarkdown(persona))] : []),
  ]
}

export async function creerProduit(ctx, projetId) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (projet.origine) return creerProduitRepris(ctx, projetId)
  const plan = lirePlan(projet)
  const nomDepot = plan.slug
  const o = config.github.proprietaire
  // La brique choisie par l'analyste (webapp par défaut) : briques/<nom>, assemblée par briques/assembler.mjs.
  const brique = /^[a-z0-9-]+$/.test(plan.brique ?? "") ? plan.brique : "webapp"

  noter(db, { projet: projetId, type: "creation", message: `Création du dépôt ${o}/${nomDepot}` })
  await creerDepot(config, nomDepot, plan.resume)
  await creerEtiquettes(config, nomDepot, [...ETIQUETTES, ...plan.lots.map((_, i) => [`lot:${i + 1}`, "ededed", plan.lots[i].nom.slice(0, 90)])])

  const script = [
    "set -eo pipefail",
    RESEAU,
    `rm -rf /travail/${nomDepot} && mkdir -p /travail/${nomDepot} && cd /travail/${nomDepot}`,
    // Les couleurs et les polices du brief deviennent les jetons Tailwind de la brique.
    ecrireFichier("/tmp/sorties/jetons.css", jetonsCss(plan.design)),
    // La brique (et sa base), le nom et le résumé à la place des jalons, les jetons ; puis ses dépendances.
    `NOM=${q(plan.nom)} RESUME=${q(plan.resume)} node /opt/usine/briques/assembler.mjs ${brique} depot /tmp/sorties/jetons.css | tee /tmp/sorties/brique.txt`,
    "cd depot",
    "mkdir -p docs .usine",
    ecrireFichier("docs/PLAN.md", planEnMarkdown(plan)),
    ecrireFichier("docs/DESIGN.md", designEnMarkdown(plan)),
    ...scriptCadre(plan, personaDu(db, projet), { repris: false }),
    // Les maquettes et documents joints à la demande : les agents s'en inspirent.
    ...scriptPieces(config, projetId, "docs/maquettes"),
    ecrireFichier(".usine/plan.json", `${JSON.stringify(plan, null, 2)}\n`),
    `DEPS=$(sed -n 's/^@@ DEPENDANCES //p' /tmp/sorties/brique.txt); DEV=$(sed -n 's/^@@ DEV //p' /tmp/sorties/brique.txt)`,
    'if [ -n "$DEPS" ]; then npm install --no-audit --no-fund $DEPS 2>&1 | tail -2; fi',
    'if [ -n "$DEV" ]; then npm install -D --no-audit --no-fund $DEV 2>&1 | tail -2; fi',
    `npm run verify 2>&1 | tee /tmp/sorties/socle.log | tail -15; ${COMPTER_TESTS} /tmp/sorties/socle.log`,
    `git init -q -b main && git add -A && git commit -q -m 'Socle : brique ${brique} et plan de fabrication'`,
    `reessayer git push -q "https://x-access-token:$JETON@github.com/${o}/${nomDepot}.git" main 2>&1 | sed "s/$JETON/***/g"`,
    `git remote add origin https://github.com/${o}/${nomDepot}.git`,
    "echo '@@ CREATION_OK'",
  ].join("\n")
  const r = await executer(config.atelier.url, config.secrets.worker, script, { env: { JETON: config.secrets.github }, minutes: 15 })
  if (!("CREATION_OK" in r.marqueurs)) throw new Error(`Création du socle impossible :\n${r.journal.slice(-1500)}`)
  const tests = Number(r.marqueurs.TESTS_PASSES ?? 0)

  for (const [i, lot] of plan.lots.entries()) await ouvrirTaches(ctx, projetId, nomDepot, lot, i + 1)
  maj(db, "projets", projetId, { depot: `${o}/${nomDepot}`, slug: nomDepot, nom: plan.nom, statut: "fabrication", plancher_tests: tests, debut_fabrication: new Date().toISOString() })
  noter(db, { projet: projetId, type: "creation", message: `Socle prêt (${tests} test), ${plan.lots.reduce((n, l) => n + l.taches.length, 0)} issues ouvertes` })
}

// Un dépôt repris : le socle de l'inventaire (mise au contrat d'hébergement) et le cadre
// (plan, mission, persona, profil) sont poussés sur la branche de base, éprouvés une dernière
// fois, puis les issues s'ouvrent. Copie : un dépôt de l'usine, sa branche main.
// Direct : le dépôt d'origine, sur usine/<slug>/integration (jamais sa branche principale).
async function creerProduitRepris(ctx, projetId) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const plan = lirePlan(projet)
  const origine = JSON.parse(projet.origine)
  const inventaire = JSON.parse(projet.inventaire)
  const profil = lireProfil(projet)
  const persona = personaDu(db, projet)
  const socle = lireSocle(config, projetId)
  if (!socle) throw new Error("Le socle de l'inventaire est introuvable sur le serveur : relance l'analyse (/usine relancer).")
  const direct = origine.mode === "direct"
  const cible = direct ? origine.depot : `${config.github.proprietaire}/${plan.slug}`
  const branche = direct ? brancheIntegration(plan.slug) : "main"

  noter(db, { projet: projetId, type: "creation", message: direct ? `Reprise directe de ${cible} : branche ${branche}` : `Copie de ${origine.depot} dans ${cible}` })
  if (!direct) await creerDepot(config, plan.slug, plan.resume)
  await creerEtiquettes(config, cible, [...ETIQUETTES, ...plan.lots.map((_, i) => [`lot:${i + 1}`, "ededed", plan.lots[i].nom.slice(0, 90)])])

  const D = `/travail/${plan.slug}`
  const script = [
    "set -eo pipefail",
    RESEAU,
    `rm -rf ${D} && mkdir -p ${D} /tmp/sorties && cd ${D}`,
    `cloner "https://x-access-token:$JETON@github.com/${origine.depot}.git" depot 2>&1 | sed "s/$JETON/***/g"`,
    `cd depot && git remote set-url origin https://github.com/${cible}.git`,
    `git checkout -q ${q(inventaire.sha_source ?? origine.branche_source)}`,
    // Le socle, rejoué tel que l'inventaire l'a éprouvé.
    ecrireFichier("/tmp/sorties/socle.patch", socle),
    "if [ -s /tmp/sorties/socle.patch ]; then git apply --index --whitespace=nowarn /tmp/sorties/socle.patch; fi",
    "mkdir -p docs .usine",
    ecrireFichier("docs/PLAN.md", planEnMarkdown(plan)),
    ...(plan.design ? [ecrireFichier("docs/DESIGN.md", designEnMarkdown(plan))] : []),
    ecrireFichier("docs/INVENTAIRE.md", inventaireEnMarkdown(inventaire, origine)),
    ...scriptCadre(plan, persona, { repris: true, pile: profil.pile }),
    ...scriptPieces(config, projetId, "docs/maquettes"),
    ecrireFichier(".usine/plan.json", `${JSON.stringify(plan, null, 2)}\n`),
    ecrireFichier(".usine/profil.json", `${JSON.stringify(profil, null, 2)}\n`),
    ecrireFichier(".usine/origine.json", `${JSON.stringify({ ...origine, sha_source: inventaire.sha_source, projet: projetId }, null, 2)}\n`),
    // La dernière épreuve avant d'ouvrir les tâches : le plancher de tests part d'ici.
    `bash -c ${q(profil.installer)} > /tmp/sorties/socle-install.log 2>&1 || { tail -20 /tmp/sorties/socle-install.log; exit 1; }`,
    `bash -c ${q(profil.construire)} > /tmp/sorties/socle-build.log 2>&1 || { tail -20 /tmp/sorties/socle-build.log; exit 1; }`,
    `bash -c ${q(profil.tester)} > /tmp/sorties/socle.log 2>&1 || true; tail -8 /tmp/sorties/socle.log; ${COMPTER_TESTS} /tmp/sorties/socle.log`,
    "git add -A",
    `git -c user.name='Usine logicielle' -c user.email='usine@wayhost.local' commit -q -m ${q(`Socle usine : reprise de ${origine.depot}${persona ? ` pour le persona « ${persona.nom} »` : ""}`)}`,
    `reessayer git push -q --force "https://x-access-token:$JETON@github.com/${cible}.git" HEAD:refs/heads/${branche} 2>&1 | sed "s/$JETON/***/g"`,
    "echo '@@ CREATION_OK'",
  ].join("\n")
  const r = await executer(config.atelier.url, config.secrets.worker, script, { env: { JETON: config.secrets.github }, minutes: 20 })
  if (!("CREATION_OK" in r.marqueurs)) throw new Error(`Reprise impossible (le socle ne s'applique plus, ou ne passe plus) :\n${r.journal.slice(-1500)}`)
  const tests = Number(r.marqueurs.TESTS_PASSES ?? 0)

  for (const [i, lot] of plan.lots.entries()) await ouvrirTaches(ctx, projetId, cible, lot, i + 1)
  maj(db, "projets", projetId, { depot: cible, branche, slug: plan.slug, nom: plan.nom, statut: "fabrication", plancher_tests: tests, debut_fabrication: new Date().toISOString() })
  noter(db, { projet: projetId, type: "creation", message: `Socle de reprise prêt (${tests} test(s)), ${plan.lots.reduce((n, l) => n + l.taches.length, 0)} issues ouvertes sur ${cible}${direct ? ` (branche ${branche})` : ""}` })
}

// Une issue par tâche, et la tâche en base. nomDepot : un dépôt de l'usine, ou « propriétaire/nom ».
async function ouvrirTaches(ctx, projetId, nomDepot, lot, numero) {
  const { config, db } = ctx
  const inserer = db.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, depend_de, issue, statut) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'attente')")
  for (const t of lot.taches) {
    const corps = [
      `**Lot ${numero} : ${lot.nom}**`,
      "",
      t.description,
      "",
      "### Critères d'acceptation",
      ...t.criteres.map((c) => `- [ ] ${c}`),
      ...(t.depend_de?.length ? ["", `Dépend de : ${t.depend_de.join(", ")}`] : []),
      "",
      "_Tâche fabriquée par l'usine logicielle : un agent la code, le vérificateur indépendant la teste, la fusion est décidée par le code._",
    ].join("\n")
    const issue = await creerIssue(config, nomDepot, { titre: `${t.cle} · ${t.titre}`, corps, etiquettes: ["usine:attente", `lot:${numero}`], assigne: false })
    inserer.run(projetId, t.cle, numero, t.titre, t.description, JSON.stringify(t.criteres), JSON.stringify(t.depend_de ?? []), issue.number)
  }
}

// Les corrections demandées à la livraison : un lot de plus, au même régime que les autres.
export async function ajouterLot(ctx, projetId, lot) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const plan = lirePlan(projet)
  plan.lots.push(lot)
  const numero = plan.lots.length
  const nomDepot = projet.depot
  const branche = brancheDeBase(projet)
  await creerEtiquettes(config, nomDepot, [[`lot:${numero}`, "ededed", lot.nom.slice(0, 90)]])
  await ecrireFichierDepot(config, nomDepot, "docs/PLAN.md", planEnMarkdown(plan), `Plan : lot ${numero}, ${lot.nom}`, branche)
  await ecrireFichierDepot(config, nomDepot, ".usine/plan.json", `${JSON.stringify(plan, null, 2)}\n`, `Plan : lot ${numero}`, branche)
  // Un lot de corrections a son propre budget de durée : le compteur repart.
  maj(db, "projets", projetId, { plan: JSON.stringify(plan), statut: "fabrication", debut_fabrication: new Date().toISOString() })
  await ouvrirTaches(ctx, projetId, nomDepot, lot, numero)
  noter(db, { projet: projetId, type: "corrections", message: `Lot ${numero} ajouté : ${lot.nom} (${lot.taches.length} tâches)` })
  return numero
}
