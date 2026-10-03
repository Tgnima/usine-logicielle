// Les accès aux applications, gérés depuis Slack : qui peut entrer où.
// Une personne reçoit son invitation par email (lien personnel, 72 h) et choisit
// elle-même son mot de passe : Slack ne voit jamais de mot de passe.
//
// Slack ne laisse que 3 secondes pour ouvrir une fenêtre : elle s'ouvre donc tout
// de suite (« Chargement… »), puis tout se passe dans cette même fenêtre (mise à
// jour par son identifiant, sans délai), jamais par une fenêtre empilée.
//
// Les clés d'API servent aux programmes (une API fabriquée par l'usine, appelée
// par un autre logiciel) : la clé n'est montrée qu'une fois, à sa création.
import { portier } from "./portier.mjs"
import { adressePortail } from "./config.mjs"
import { courrielConfigure, envoyerInvitation } from "./courriel.mjs"

const md = (texte) => ({ type: "mrkdwn", text: String(texte).slice(0, 2900) })
const texte = (t) => ({ type: "plain_text", text: String(t).slice(0, 150), emoji: true })
const bouton = (t, action_id, value = "1", style) => ({ type: "button", text: texte(t), action_id, value: String(value), ...(style ? { style } : {}) })

const produits = (db) => db.prepare("SELECT slug, nom FROM projets WHERE slug IS NOT NULL AND statut NOT IN ('abandonne', 'supprime') ORDER BY id DESC").all()

const vueSimple = (titre, blocs, { retour = false } = {}) => ({
  type: "modal", callback_id: "modal_acces", title: texte(titre), close: texte("Fermer"),
  blocks: [...blocs, ...(retour ? [{ type: "actions", elements: [bouton("← Retour à la liste", "acces_liste")] }] : [])],
})
const chargement = () => vueSimple("Accès", [{ type: "section", text: md(":hourglass_flowing_sand: Chargement…") }])

export async function vueAcces(ctx) {
  const utilisateurs = await portier("utilisateurs")
  const cles = (await portier("cles").catch(() => [])).filter((c) => c.actif)
  const noms = Object.fromEntries(produits(ctx.db).map((p) => [p.slug, p.nom ?? p.slug]))
  const decrire = (u) => (u.role === "admin" ? "toutes les applications, tableau de bord et emails" : u.applis.includes("*") ? "toutes les applications" : u.applis.map((a) => noms[a] ?? a).join(", ") || "aucune application")
  return vueSimple("Accès", [
    { type: "section", text: md(`Chaque application de l'usine est derrière une page de connexion. Les personnes ci-dessous peuvent entrer ; leur portail : ${adressePortail(ctx.config)}`) },
    { type: "divider" },
    ...(utilisateurs.length
      ? utilisateurs.map((u) => ({
          type: "section",
          text: md(`*${u.email}*${u.nom ? ` · ${u.nom}` : ""}\n${u.role === "admin" ? "👑 administrateur" : "👤 membre"} · ${decrire(u)}${u.active ? "" : "\n_⏳ invitation pas encore acceptée_"}`),
          accessory: {
            type: "overflow", action_id: "acces_menu",
            options: [
              { text: texte("Modifier les accès"), value: `modifier:${u.id}` },
              { text: texte("Renvoyer l'invitation"), value: `lien:${u.id}` },
              { text: texte("Retirer l'accès"), value: `retirer:${u.id}` },
            ],
          },
        }))
      : [{ type: "section", text: md("_Personne pour l'instant. Commence par ton propre compte, en administrateur._") }]),
    { type: "actions", elements: [bouton("➕ Ajouter une personne", "acces_ajouter", "1", "primary")] },
    { type: "divider" },
    { type: "section", text: md("*Clés d'API* · pour qu'un programme appelle une application (en-tête `Authorization: Bearer <clé>`)") },
    ...cles.map((c) => ({
      type: "section",
      text: md(`🔑 *${c.nom}* · \`${c.debut}…\` · ${c.applis.includes("*") ? "toutes les applications" : c.applis.map((a) => noms[a] ?? a).join(", ")}\n_créée le ${c.cree_le.slice(0, 10)}${c.cree_par ? ` par ${c.cree_par}` : ""} · ${c.utilisee_le ? `dernier usage ${c.utilisee_le.slice(0, 16)}` : "jamais utilisée"}_`),
      accessory: { type: "overflow", action_id: "acces_cle_menu", options: [{ text: texte("Révoquer la clé"), value: `revoquer:${c.id}` }] },
    })),
    { type: "actions", elements: [bouton("🔑 Créer une clé d'API", "acces_cle_ajouter")] },
    ...(courrielConfigure() ? [] : [{ type: "context", elements: [md("⚠️ Aucun service d'envoi d'emails n'est configuré : les liens d'invitation s'afficheront ici, à transmettre toi-même.")] }]),
  ])
}

export function vueAjout(ctx, u = null) {
  const options = [{ text: texte("Toutes les applications"), value: "*" }, ...produits(ctx.db).map((p) => ({ text: texte(p.nom ?? p.slug), value: p.slug }))].slice(0, 100)
  const choisies = u ? options.filter((o) => u.applis.includes(o.value)) : []
  const membre = { text: texte("Membre : les applications choisies ci-dessous"), value: "membre" }
  const admin = { text: texte("Administrateur : tout, dont le tableau de bord de l'usine"), value: "admin" }
  return {
    type: "modal", callback_id: "modal_acces_ajout", private_metadata: u ? String(u.id) : "",
    title: texte(u ? "Modifier les accès" : "Ajouter une personne"), submit: texte(u ? "Enregistrer" : "Inviter par email"), close: texte("Fermer"),
    blocks: [
      u ? { type: "section", text: md(`*${u.email}*`) } : { type: "input", block_id: "email", label: texte("Adresse email"), element: { type: "email_text_input", action_id: "v" } },
      ...(u ? [] : [{ type: "input", block_id: "nom", optional: true, label: texte("Nom"), element: { type: "plain_text_input", action_id: "v" } }]),
      { type: "input", block_id: "role", label: texte("Rôle"), element: { type: "radio_buttons", action_id: "v", options: [membre, admin], initial_option: u?.role === "admin" ? admin : membre } },
      {
        type: "input", block_id: "applis", optional: true, label: texte("Applications"), hint: texte("Pour un membre. Un administrateur a accès à tout."),
        element: { type: "multi_static_select", action_id: "v", placeholder: texte("Choisir…"), options, ...(choisies.length ? { initial_options: choisies } : {}) },
      },
      { type: "actions", elements: [bouton("← Retour à la liste", "acces_liste")] },
    ],
  }
}

export function vueCle(ctx) {
  const options = [{ text: texte("Toutes les applications"), value: "*" }, ...produits(ctx.db).map((p) => ({ text: texte(p.nom ?? p.slug), value: p.slug }))].slice(0, 100)
  return {
    type: "modal", callback_id: "modal_acces_cle", title: texte("Créer une clé d'API"), submit: texte("Créer la clé"), close: texte("Fermer"),
    blocks: [
      { type: "input", block_id: "nom", label: texte("Nom"), hint: texte("Qui s'en sert : « intégration CRM », « script de Paul »…"), element: { type: "plain_text_input", action_id: "v", max_length: 60 } },
      { type: "input", block_id: "applis", label: texte("Applications"), element: { type: "multi_static_select", action_id: "v", placeholder: texte("Choisir…"), options } },
      { type: "actions", elements: [bouton("← Retour à la liste", "acces_liste")] },
    ],
  }
}

// Envoie l'invitation par email ; rend la vue du résultat (avec le lien en secours si l'envoi échoue).
async function inviter({ email, lien, role, applis, par, titre }) {
  if (courrielConfigure()) {
    try {
      await envoyerInvitation({ email, lien, role, applis, par })
      console.log(`Invitation envoyée par email à ${email} (par ${par})`)
      return vueSimple(titre, [
        { type: "section", text: md(`:white_check_mark: Invitation envoyée par email à *${email}*.\nLe lien est personnel et valable *72 heures* ; la personne y choisit son mot de passe.`) },
        { type: "context", elements: [md("Pas reçu ? Vérifie les indésirables, ou « Renvoyer l'invitation » depuis la liste.")] },
      ], { retour: true })
    } catch (error) {
      console.error(`Invitation : l'email à ${email} n'est pas parti :`, error.message)
      return vueSimple(titre, [
        { type: "section", text: md(`:warning: L'email à *${email}* n'a pas pu partir (${error.message.slice(0, 200)}).\nTransmets-lui ce lien toi-même (personnel, valable 72 heures) :`) },
        { type: "section", text: md(`\`${lien}\``) },
      ], { retour: true })
    }
  }
  return vueSimple(titre, [
    { type: "section", text: md(`Transmets ce lien à *${email}* (personnel, valable *72 heures*) ; la personne y choisit son mot de passe :`) },
    { type: "section", text: md(`\`${lien}\``) },
  ], { retour: true })
}

// Branche les actions Slack. estAdmin vient de slack.mjs.
export function brancherAcces(app, ctx, { estAdmin }) {
  const erreur = (e) => vueSimple("Accès", [{ type: "section", text: md(`:x: ${e.message.slice(0, 300)}`) }], { retour: true })
  const maj = (view_id, vue) => app.client.views.update({ view_id, view: vue }).catch((e) => console.error("Accès :", e.data?.error ?? e.message))
  const liste = async (view_id) => maj(view_id, await vueAcces(ctx).catch(erreur))

  // Ouvrir : la fenêtre d'abord (dans les 3 secondes), le contenu ensuite.
  const ouvrir = async (trigger_id, user) => {
    if (!estAdmin(user)) return
    const r = await app.client.views.open({ trigger_id, view: chargement() }).catch((e) => console.error("Accès (ouverture) :", e.data?.error ?? e.message))
    if (r?.view?.id) await liste(r.view.id)
  }
  app.action("acces_ouvrir", async ({ ack, body }) => {
    await ack()
    await ouvrir(body.trigger_id, body.user.id)
  })
  app.action("acces_liste", async ({ ack, body }) => {
    await ack()
    await liste(body.view.id)
  })
  app.action("acces_ajouter", async ({ ack, body }) => {
    await ack()
    if (estAdmin(body.user.id)) await maj(body.view.id, vueAjout(ctx))
  })
  app.action("acces_menu", async ({ ack, body }) => {
    await ack()
    if (!estAdmin(body.user.id)) return
    const vueId = body.view.id
    const par = body.user.name ?? body.user.id
    const [action, id] = body.actions[0].selected_option.value.split(":")
    try {
      const u = (await portier("utilisateurs")).find((x) => String(x.id) === id)
      if (!u) return liste(vueId)
      if (action === "modifier") return maj(vueId, vueAjout(ctx, u))
      if (action === "lien") {
        await maj(vueId, vueSimple("Invitation", [{ type: "section", text: md(`:hourglass_flowing_sand: Nouveau lien pour *${u.email}*, envoi de l'email…`) }]))
        const { lien } = await portier(`utilisateurs/${u.id}/invitation`, { methode: "POST" })
        return maj(vueId, await inviter({ email: u.email, lien, role: u.role, applis: u.applis, par, titre: "Invitation" }))
      }
      if (action === "retirer") {
        await portier(`utilisateurs/${u.id}`, { methode: "DELETE" })
        console.log(`Accès retiré : ${u.email} (par ${par})`)
        return liste(vueId)
      }
    } catch (e) {
      await maj(vueId, erreur(e))
    }
  })
  app.action("acces_cle_ajouter", async ({ ack, body }) => {
    await ack()
    if (estAdmin(body.user.id)) await maj(body.view.id, vueCle(ctx))
  })
  app.action("acces_cle_menu", async ({ ack, body }) => {
    await ack()
    if (!estAdmin(body.user.id)) return
    const [action, id] = body.actions[0].selected_option.value.split(":")
    try {
      if (action === "revoquer") {
        await portier(`cles/${Number(id)}`, { methode: "DELETE" })
        console.log(`Clé d'API ${id} révoquée (par ${body.user.name ?? body.user.id})`)
      }
      await liste(body.view.id)
    } catch (e) {
      await maj(body.view.id, erreur(e))
    }
  })
  app.view("modal_acces_cle", async ({ ack, view, body }) => {
    if (!estAdmin(body.user.id)) return ack()
    const v = view.state.values
    try {
      const { cle } = await portier("cles", { methode: "POST", corps: { nom: v.nom.v.value, applis: (v.applis.v.selected_options ?? []).map((o) => o.value), par: body.user.name ?? body.user.id } })
      await ack({
        response_action: "update",
        view: vueSimple("Clé d'API créée", [
          { type: "section", text: md(":white_check_mark: Voici la clé. *Copie-la maintenant* : elle ne sera plus jamais affichée (seule son empreinte est gardée).") },
          { type: "section", text: md(`\`${cle}\``) },
          { type: "context", elements: [md("À utiliser dans l'en-tête `Authorization: Bearer <clé>`. Perdue ou exposée ? Révoque-la et crée-en une autre.")] },
        ], { retour: true }),
      })
    } catch (error) {
      await ack({ response_action: "errors", errors: { nom: error.message.slice(0, 150) } }).catch(() => {})
    }
  })
  app.view("modal_acces_ajout", async ({ ack, view, body }) => {
    const v = view.state.values
    const role = v.role.v.selected_option.value
    const applis = (v.applis.v.selected_options ?? []).map((o) => o.value)
    const par = body.user.name ?? body.user.id
    try {
      if (view.private_metadata) {
        await portier(`utilisateurs/${view.private_metadata}`, { methode: "PATCH", corps: { role, applis } })
        await ack({ response_action: "update", view: chargement() })
        return liste(view.id)
      }
      const email = String(v.email.v.value ?? "").trim()
      const { lien } = await portier("utilisateurs", { methode: "POST", corps: { email, nom: v.nom?.v?.value ?? null, role, applis, par } })
      // Répondre tout de suite à Slack, puis envoyer l'email (quelques secondes) et afficher le résultat.
      await ack({ response_action: "update", view: vueSimple("Invitation", [{ type: "section", text: md(`:hourglass_flowing_sand: Compte créé pour *${email}*, envoi de l'invitation par email…`) }]) })
      await maj(view.id, await inviter({ email, lien, role, applis, par, titre: "Invitation" }))
    } catch (error) {
      await ack({ response_action: "errors", errors: { [view.private_metadata ? "role" : "email"]: error.message.slice(0, 150) } }).catch(() => {})
    }
  })
  return ouvrir
}
