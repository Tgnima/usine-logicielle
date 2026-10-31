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
  reorienter <n°> "<direction>" [persona_id]
                                 change de direction pendant la fabrication (et de persona, s'il est validé)
  decider <escalade> <A|B|C> ["consigne"]
  production <n°> [--donnees demo|vide] [--emails captures|reels] [--horloge acceleree|reelle] [--autorises "a@b.fr,@domaine.fr"]
                                 met en production (après livraison)
  journal <n°>                   les derniers événements
  abandonner <n°>                abandonne un plan pas encore validé
  admin <email>                  crée le premier administrateur (sans Slack) et donne son lien d'invitation
  mettre-a-jour                  met l'usine à jour depuis GitHub (après la tâche en cours)
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
  reorienter: () => appel("POST", `/reorienter/${a}`, { texte: b, persona_id: c ? Number(c) : null }),
  decider: () => appel("POST", `/decider/${a}`, { choix: String(b).toUpperCase(), texte: c }),
  production: () => {
    // Les options --cle valeur deviennent les choix de production.
    const args = process.argv.slice(4)
    const choix = {}
    for (let i = 0; i < args.length; i += 2) if (args[i]?.startsWith("--")) choix[args[i].slice(2).replace("autorises", "destinataires_autorises")] = args[i + 1]
    return appel("POST", `/production/${a}`, Object.keys(choix).length ? { choix } : {})
  },
  journal: async () => (await appel("GET", `/journal/${a}`)).map((l) => `${l.le}  ${l.type.padEnd(12)} ${l.message.split("\n")[0]}`).join("\n"),
  relancer: () => appel("POST", `/relancer/${a}`, {}),
  abandonner: () => appel("POST", `/abandonner/${a}`, {}),
  admin: () => appel("POST", "/admin", { email: a }),
  "mettre-a-jour": () => appel("POST", "/mettre-a-jour", {}),
  stop: () => appel("POST", "/stop", {}),
  reprendre: () => appel("POST", "/reprendre", {}),
}

if (!table[commande]) {
  console.log(AIDE)
  process.exit(commande ? 1 : 0)
}
montrer(await table[commande]())
