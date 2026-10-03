// Les accès aux applications, gérés depuis Slack : qui peut entrer où.
// Une personne reçoit un lien d'invitation (72 h) et choisit elle-même son mot
// de passe : Slack ne voit jamais de mot de passe.
import { portier } from "./portier.mjs"
import { adressePortail } from "./config.mjs"

const md = (texte) => ({ type: "mrkdwn", text: String(texte).slice(0, 2900) })
const texte = (t) => ({ type: "plain_text", text: String(t).slice(0, 150), emoji: true })

const produits = (db) => db.prepare("SELECT slug, nom FROM projets WHERE slug IS NOT NULL AND statut NOT IN ('abandonne', 'supprime') ORDER BY id DESC").all()

export async function vueAcces(ctx) {
  const utilisateurs = await portier("utilisateurs")
  const noms = Object.fromEntries(produits(ctx.db).map((p) => [p.slug, p.nom ?? p.slug]))
  const decrire = (u) => (u.role === "admin" ? "toutes les applications, tableau de bord et emails" : u.applis.includes("*") ? "toutes les applications" : u.applis.map((a) => noms[a] ?? a).join(", ") || "aucune application")
  return {
    type: "modal", callback_id: "modal_acces",
    title: texte("Accès"), close: texte("Fermer"),
    blocks: [
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
                { text: texte("Nouveau lien d'invitation"), value: `lien:${u.id}` },
                { text: texte("Retirer l'accès"), value: `retirer:${u.id}` },
              ],
            },
          }))
        : [{ type: "section", text: md("_Personne pour l'instant. Commence par ton propre compte, en administrateur._") }]),
      { type: "actions", elements: [{ type: "button", text: texte("➕ Ajouter une personne"), action_id: "acces_ajouter", value: "1", style: "primary" }] },
    ],
  }
}

export function vueAjout(ctx, u = null) {
  const options = [{ text: texte("Toutes les applications"), value: "*" }, ...produits(ctx.db).map((p) => ({ text: texte(p.nom ?? p.slug), value: p.slug }))].slice(0, 100)
  const choisies = u ? options.filter((o) => u.applis.includes(o.value)) : []
  return {
    type: "modal", callback_id: "modal_acces_ajout", private_metadata: u ? String(u.id) : "",
    title: texte(u ? "Modifier les accès" : "Ajouter une personne"), submit: texte(u ? "Enregistrer" : "Inviter"), close: texte("Retour"),
    blocks: [
      u
        ? { type: "section", text: md(`*${u.email}*`) }
        : { type: "input", block_id: "email", label: texte("Adresse email"), element: { type: "email_text_input", action_id: "v" } },
      ...(u ? [] : [{ type: "input", block_id: "nom", optional: true, label: texte("Nom"), element: { type: "plain_text_input", action_id: "v" } }]),
      {
        type: "input", block_id: "role", label: texte("Rôle"),
        element: {
          type: "radio_buttons", action_id: "v",
          options: [
            { text: texte("Membre : les applications choisies ci-dessous"), value: "membre" },
            { text: texte("Administrateur : tout, dont le tableau de bord de l'usine"), value: "admin" },
          ],
          initial_option: u?.role === "admin" ? { text: texte("Administrateur : tout, dont le tableau de bord de l'usine"), value: "admin" } : { text: texte("Membre : les applications choisies ci-dessous"), value: "membre" },
        },
      },
      {
        type: "input", block_id: "applis", optional: true, label: texte("Applications"),
        hint: texte("Pour un membre. Un administrateur a accès à tout."),
        element: { type: "multi_static_select", action_id: "v", placeholder: texte("Choisir…"), options, ...(choisies.length ? { initial_options: choisies } : {}) },
      },
    ],
  }
}

const vueLien = (titre, email, lien) => ({
  type: "modal", title: texte(titre), close: texte("Fermer"),
  blocks: [
    { type: "section", text: md(`Envoie ce lien à *${email}*. Il est personnel et valable *72 heures* ; la personne y choisit son mot de passe.`) },
    { type: "section", text: md(`\`${lien}\``) },
    { type: "context", elements: [md("Si le lien expire, ouvre à nouveau les accès et choisis « Nouveau lien d'invitation ».")] },
  ],
})

// Branche les actions Slack. estAdmin et refus viennent de slack.mjs.
export function brancherAcces(app, ctx, { estAdmin, refus }) {
  const ouvrir = async (trigger_id, user) => {
    if (!estAdmin(user)) return
    const vue = await vueAcces(ctx).catch((e) => ({ type: "modal", title: texte("Accès"), close: texte("Fermer"), blocks: [{ type: "section", text: md(`:x: Le portier ne répond pas : ${e.message}`) }] }))
    await app.client.views.open({ trigger_id, view: vue })
  }
  app.action("acces_ouvrir", async ({ ack, body }) => {
    await ack()
    await ouvrir(body.trigger_id, body.user.id)
  })
  app.action("acces_ajouter", async ({ ack, body }) => {
    await ack()
    if (!estAdmin(body.user.id)) return
    await app.client.views.push({ trigger_id: body.trigger_id, view: vueAjout(ctx) })
  })
  app.action("acces_menu", async ({ ack, body }) => {
    await ack()
    if (!estAdmin(body.user.id)) return
    const [action, id] = body.actions[0].selected_option.value.split(":")
    const u = (await portier("utilisateurs")).find((x) => String(x.id) === id)
    if (!u) return
    if (action === "modifier") return app.client.views.push({ trigger_id: body.trigger_id, view: vueAjout(ctx, u) })
    if (action === "lien") {
      const { lien } = await portier(`utilisateurs/${u.id}/invitation`, { methode: "POST" })
      return app.client.views.push({ trigger_id: body.trigger_id, view: vueLien("Nouveau lien", u.email, lien) })
    }
    if (action === "retirer") {
      await portier(`utilisateurs/${u.id}`, { methode: "DELETE" })
      console.log(`Accès retiré : ${u.email} (par ${body.user.name ?? body.user.id})`)
      return app.client.views.update({ view_id: body.view.id, view: await vueAcces(ctx) })
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
        await ack({ response_action: "clear" })
        return
      }
      const email = v.email.v.value
      const { lien } = await portier("utilisateurs", { methode: "POST", corps: { email, nom: v.nom?.v?.value ?? null, role, applis, par } })
      await ack({ response_action: "update", view: vueLien("Invitation prête", email, lien) })
    } catch (error) {
      await ack({ response_action: "errors", errors: { [view.private_metadata ? "role" : "email"]: error.message.slice(0, 150) } })
    }
  })
  return ouvrir
}
