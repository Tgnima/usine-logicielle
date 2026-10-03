// Après la validation du plan : créer le dépôt du produit à partir de la brique,
// vérifier que le socle passe, puis ouvrir une issue par tâche.
import { creerDepot, creerEtiquettes, creerIssue, ecrireFichierDepot } from "./github.mjs"
import { RESEAU, executer, ecrireFichier, q } from "./travaux.mjs"
import { maj, noter, obtenir, plan as lirePlan } from "./db.mjs"
import { planEnMarkdown } from "./analyste.mjs"
import { designEnMarkdown, jetonsCss } from "./design.mjs"

export const ETIQUETTES = [
  ["usine:attente", "c5def5", "Tâche planifiée, en attente de ses dépendances"],
  ["usine:en-cours", "1d76db", "Un agent y travaille"],
  ["usine:verification", "fbca04", "Le vérificateur indépendant la teste"],
  ["usine:fusionnee", "0e8a16", "Vérifiée et fusionnée"],
  ["usine:bloquant", "b60205", "L'usine a besoin d'une décision humaine"],
  ["usine:abandonnee", "cccccc", "Abandonnée"],
]

// Le nombre de tests passés et échoués, lu dans la sortie de node --test.
export const COMPTER_TESTS = `awk '/^ℹ pass [0-9]+/{p=$3} /^ℹ fail [0-9]+/{f=$3} END{print "@@ TESTS_PASSES " (p+0); print "@@ TESTS_ECHECS " (f+0)}'`

export async function creerProduit(ctx, projetId) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
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

// Une issue par tâche, et la tâche en base.
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
  const nomDepot = projet.depot.split("/")[1]
  await creerEtiquettes(config, nomDepot, [[`lot:${numero}`, "ededed", lot.nom.slice(0, 90)]])
  await ecrireFichierDepot(config, nomDepot, "docs/PLAN.md", planEnMarkdown(plan), `Plan : lot ${numero}, ${lot.nom}`)
  await ecrireFichierDepot(config, nomDepot, ".usine/plan.json", `${JSON.stringify(plan, null, 2)}\n`, `Plan : lot ${numero}`)
  // Un lot de corrections a son propre budget de durée : le compteur repart.
  maj(db, "projets", projetId, { plan: JSON.stringify(plan), statut: "fabrication", debut_fabrication: new Date().toISOString() })
  await ouvrirTaches(ctx, projetId, nomDepot, lot, numero)
  noter(db, { projet: projetId, type: "corrections", message: `Lot ${numero} ajouté : ${lot.nom} (${lot.taches.length} tâches)` })
  return numero
}
