// Les premiers pas dans la console : ce qu'il reste à faire pour que l'usine soit prête,
// calculé à partir de l'état réel (pas d'une case cochée à la main). La console en fait un
// assistant ; il se rouvre depuis les Réglages et disparaît quand tout l'essentiel est fait.
import { lireReglage } from "./couts.mjs"
import { lireTests } from "./fournisseurs.mjs"
import { portier } from "./portier.mjs"

let compte = { valeur: null, le: 0 }
// Le compte GitHub de l'usine (mémorisé 5 min : la page se recharge souvent).
export async function compteGithub(ctx, { frais = false } = {}) {
  if (!frais && compte.valeur && Date.now() - compte.le < 300_000) return compte.valeur
  let v
  try {
    const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${ctx.config.secrets.github}`, "user-agent": "usine-logicielle" }, signal: AbortSignal.timeout(8_000) })
    v = r.ok ? { ok: true, login: (await r.json()).login } : { ok: false, detail: `réponse ${r.status}` }
  } catch {
    v = { ok: false, detail: "GitHub injoignable" }
  }
  // Une application GitHub (installation) n'a pas d'utilisateur : son compte vient de l'installation.
  if (!v.ok && ctx.forge?.compte) v = { ok: true, login: ctx.forge.compte }
  compte = { valeur: v, le: Date.now() }
  return v
}

const marche = (r) => Object.values(r ?? {}).some((x) => x?.etat === "ok")

export async function premiersPas(ctx) {
  const { db } = ctx
  const tests = lireTests(ctx)
  const [github, utilisateurs] = await Promise.all([compteGithub(ctx), portier("utilisateurs").catch(() => [])])
  const { courrielConfigure } = await import("./courriel.mjs")
  const n = (sql) => db.prepare(sql).get()?.n ?? 0
  const claude = marche(tests.resultats?.["claude-code"])
  const codex = marche(tests.resultats?.codex)
  const etapes = [
    {
      id: "ia", obligatoire: true, fait: claude && codex,
      titre: "Choisir ton fournisseur d'IA",
      detail: !tests.le ? "Pose ton abonnement ou tes clés (Claude pour coder, Codex pour vérifier), puis teste les connexions."
        : claude && codex ? "Claude et Codex répondent." : `${claude ? "Claude répond" : "Claude ne répond pas encore"} · ${codex ? "Codex répond" : "Codex ne répond pas encore"}.`,
      aller: "#/reglages", action: "Régler les fournisseurs",
    },
    {
      id: "github", obligatoire: true, fait: !!github.ok,
      titre: "Connecter GitHub",
      detail: github.ok ? `Les dépôts des produits seront créés chez ${github.login}.` : "Chaque produit reçoit son dépôt : le code, une pull request par tâche, les issues du plan.",
      aller: "#/reglages", action: "Connecter GitHub",
    },
    {
      id: "courriel", obligatoire: false, fait: courrielConfigure(),
      titre: "Envoyer les invitations par email",
      detail: courrielConfigure() ? "Les invitations partent par email." : "Facultatif : sans serveur d'envoi, tu transmets toi-même les liens d'invitation.",
      aller: "#/acces", action: "Voir les accès",
    },
    {
      id: "equipe", obligatoire: false, fait: utilisateurs.filter((u) => u.actif !== 0 && u.actif !== false).length > 1,
      titre: "Inviter ton équipe",
      detail: "Facultatif : des administrateurs pour piloter l'usine, des membres pour tester les produits.",
      aller: "#/acces", action: "Inviter",
    },
    {
      id: "persona", obligatoire: false, fait: n("SELECT COUNT(*) AS n FROM personas WHERE statut = 'valide'") > 0,
      titre: "Décrire tes utilisateurs (personas)",
      detail: "Facultatif mais utile : l'analyste construit le plan pour eux, et la recette les fait jouer.",
      aller: "#/personas", action: "Créer un persona",
    },
    {
      id: "projet", obligatoire: true, fait: n("SELECT COUNT(*) AS n FROM projets") > 0,
      titre: "Lancer ton premier projet",
      detail: "Décris ce que tu veux construire : l'analyste propose un plan, tu le relis, la fabrication se suit en direct.",
      aller: "#/nouveau", action: "Nouveau projet",
    },
  ]
  const essentiels = etapes.filter((e) => e.obligatoire)
  return {
    etapes,
    faites: essentiels.filter((e) => e.fait).length,
    total: essentiels.length,
    termine: essentiels.every((e) => e.fait),
    masque: lireReglage(db, "premiers_pas_masque", "") === "1",
  }
}
