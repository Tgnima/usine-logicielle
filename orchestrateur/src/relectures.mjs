// Les relectures entre agents, avant le vérificateur : un regard neuf sur le
// changement, avec une grille. Un défaut grave renvoie la tâche à l'agent, comme
// un refus du vérificateur ; les remarques mineures sont laissées sur la PR.
//
//   relireSecurite : injections, XSS, secrets, accès, redirections, données personnelles…
import { executer, ecrireFichier, lireFichier, q } from "./travaux.mjs"
import { extraireJson } from "./analyste.mjs"
import { enregistrer, usagesClaude } from "./couts.mjs"

const GRILLE_SECURITE = `Grille (une application web Node/Express + React, publiée sur Internet) :
1. Injection SQL : toute requête SQL construite par concaténation de valeurs venant du visiteur (au lieu de paramètres « ? »).
2. XSS : dangerouslySetInnerHTML, innerHTML, insertion de HTML venant du visiteur ou d'un modèle de langage sans échappement.
3. Secrets : clé, jeton ou mot de passe écrit dans le code ou les tests.
4. Accès : une route qui modifie ou supprime sans vérifier ce qu'elle reçoit ; un identifiant fourni par le visiteur qui donne accès à la donnée d'un autre.
5. Redirection ouverte : rediriger vers une URL fournie par le visiteur sans liste autorisée.
6. Fichiers et réseau : chemin de fichier construit avec une valeur du visiteur (../) ; appel réseau vers une URL fournie par le visiteur (SSRF).
7. Données personnelles : emails, contenus ou jetons écrits dans les journaux (console.log) ou renvoyés à qui ne doit pas les voir.
8. Validation : entrée de route non validée (type, longueur, valeurs permises) pouvant casser le serveur ou la base.
9. Déni de service : boucle, export ou traitement sans borne déclenché par une simple requête.
10. Contournement : modification de server/securite.js, server/email.js, server/index.js ou des tests de sécurité.`

function consigneSecurite(projet, tache, diff) {
  return `Tu es relecteur sécurité dans une usine logicielle. Tu relis un changement AVANT qu'il soit testé et fusionné. Tu ne le modifies pas.

Produit : « ${projet.nom} ». Tâche : ${tache.cle} · ${tache.titre}.

${GRILLE_SECURITE}

Le changement (diff unifié, éventuellement tronqué) :
<diff>
${diff}
</diff>

Classe chaque défaut réel que tu VOIS dans ce diff :
- « grave » : exploitable par un visiteur d'Internet, ou une fuite de secret ou de données personnelles ;
- « mineur » : à améliorer, sans risque immédiat.
N'invente rien : pas de défaut supposé dans du code que tu ne vois pas. Pas de remarque de style.

Réponds UNIQUEMENT par ce JSON :
{"graves": [{"fichier": "…", "probleme": "…", "correction": "…"}], "mineurs": [{"fichier": "…", "probleme": "…"}], "resume": "une phrase"}`
}

export async function relireSecurite(ctx, projet, tache, nomDepot) {
  const { config, db } = ctx
  const atelier = config.atelier.url
  const jeton = config.secrets.worker
  const modele = config.modeles?.relecteur?.modele ?? config.modeles.atelier.modele
  // Le diff de la branche (le code, pas le verrou des dépendances), borné.
  const diff = await executer(atelier, jeton, [
    `cd /travail/${nomDepot}/depot`,
    "git diff main...HEAD -- . ':(exclude)package-lock.json' ':(exclude)dist/**' > /tmp/sorties/tache/diff.txt",
    "echo \"@@ DIFF_OCTETS $(wc -c < /tmp/sorties/tache/diff.txt)\"",
  ].join("\n"), { minutes: 2 })
  const texteDiff = String((await lireFichier(atelier, jeton, "/tmp/sorties/tache/diff.txt")) ?? "")
  if (!texteDiff.trim()) return { graves: [], mineurs: [], resume: "aucun changement de code" }
  const borne = texteDiff.length > 120_000 ? `${texteDiff.slice(0, 120_000)}\n[… diff tronqué : ${diff.marqueurs.DIFF_OCTETS} octets au total]` : texteDiff
  const r = await executer(atelier, jeton, [
    "mkdir -p /tmp/sorties/relecture && cd /tmp/sorties/relecture",
    ecrireFichier("/tmp/sorties/relecture/consigne.md", consigneSecurite(projet, tache, borne)),
    `claude -p "$(cat consigne.md)" --output-format json --model ${q(modele)} --tools "" --max-turns 2 > reponse.json`,
    "echo \"@@ RELECTURE_CODE $?\"",
  ].join("\n"), { minutes: 10 })
  let sortie
  try {
    sortie = JSON.parse(await lireFichier(atelier, jeton, "/tmp/sorties/relecture/reponse.json"))
  } catch {
    // Une relecture impossible ne bloque pas la tâche : le vérificateur passe ensuite.
    return { graves: [], mineurs: [], resume: "relecture indisponible", indisponible: true }
  }
  enregistrer(db, { projet: projet.id, tache: tache.id, role: "relecteur-securite", moteur: "claude-code", usages: usagesClaude(sortie), duree_s: r.duree_s ?? 0 })
  try {
    const v = extraireJson(String(sortie.result ?? ""))
    return { graves: Array.isArray(v.graves) ? v.graves : [], mineurs: Array.isArray(v.mineurs) ? v.mineurs : [], resume: String(v.resume ?? "") }
  } catch {
    return { graves: [], mineurs: [], resume: "relecture illisible", indisponible: true }
  }
}

export const decrireDefaut = (d) => `${d.fichier ? `\`${d.fichier}\` : ` : ""}${d.probleme}${d.correction ? ` → ${d.correction}` : ""}`
