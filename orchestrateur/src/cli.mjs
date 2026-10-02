#!/usr/bin/env node
// La CLI de l'usine, pour piloter sans Slack (ou pour tester) :
//   docker compose exec orchestrateur node src/cli.mjs <commande> …
const AIDE = `Usage : node src/cli.mjs <commande>
  nouveau "<demande>"            lance un projet
  statut                         l'état des projets
  plan <n°>                      affiche le plan
  repondre <n°> "<réponses>"     répond aux questions de l'analyste
  valider <n°>                   valide le plan : la fabrication commence
  corriger <n°> "<retours>"      corrige le plan (ou demande des corrections après livraison)
  decider <escalade> <A|B|C> ["consigne"]
  production <n°>                met en production (après livraison)
  journal <n°>                   les derniers événements
  relancer <n°> · stop · reprendre`

const [commande, a, b, c] = process.argv.slice(2)
const appel = async (methode, chemin, corps) => {
  const res = await fetch(`http://127.0.0.1:8090${chemin}`, { method: methode, headers: { "content-type": "application/json" }, body: corps ? JSON.stringify(corps) : undefined })
  return res.json()
}
const montrer = (x) => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2))

const table = {
  nouveau: () => appel("POST", "/projets", { prompt: a }),
  statut: () => appel("GET", "/statut"),
  plan: async () => (await appel("GET", `/plan/${a}`)).texte,
  repondre: () => appel("POST", `/repondre/${a}`, { texte: b }),
  valider: () => appel("POST", `/valider/${a}`, {}),
  corriger: () => appel("POST", `/corriger/${a}`, { texte: b }),
  decider: () => appel("POST", `/decider/${a}`, { choix: String(b).toUpperCase(), texte: c }),
  production: () => appel("POST", `/production/${a}`, {}),
  journal: async () => (await appel("GET", `/journal/${a}`)).map((l) => `${l.le}  ${l.type.padEnd(12)} ${l.message.split("\n")[0]}`).join("\n"),
  relancer: () => appel("POST", `/relancer/${a}`, {}),
  stop: () => appel("POST", "/stop", {}),
  reprendre: () => appel("POST", "/reprendre", {}),
}

if (!table[commande]) {
  console.log(AIDE)
  process.exit(commande ? 1 : 0)
}
montrer(await table[commande]())
