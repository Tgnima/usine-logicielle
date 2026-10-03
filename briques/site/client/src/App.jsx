// Le point de départ du site vitrine : une page d'accueil et un formulaire de contact,
// construits avec les composants de client/src/ui. Les tâches de l'usine le remplacent
// par le vrai site (une page par entrée de server/contenu.js).
import { useState } from "react"
import { Bouton, Champ } from "./ui/index.jsx"

function Contact() {
  const [etat, setEtat] = useState({ envoi: false, ok: false, erreur: "" })
  async function envoyer(e) {
    e.preventDefault()
    setEtat({ envoi: true, ok: false, erreur: "" })
    const donnees = Object.fromEntries(new FormData(e.currentTarget))
    const r = await fetch("/api/public/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(donnees) }).catch(() => null)
    const corps = await r?.json().catch(() => ({}))
    setEtat(r?.ok ? { envoi: false, ok: true, erreur: "" } : { envoi: false, ok: false, erreur: corps?.erreur ?? "L'envoi a échoué. Réessaie dans un instant." })
  }
  if (etat.ok) return <p role="status" className="text-sm">Merci, ton message est bien arrivé. Nous te répondons rapidement.</p>
  return (
    <form onSubmit={envoyer} className="grid gap-4 max-w-lg" noValidate>
      <Champ label="Nom" name="nom" autoComplete="name" required />
      <Champ label="Email" name="email" type="email" autoComplete="email" required />
      <Champ label="Message" name="message" as="textarea" rows={5} required />
      {etat.erreur && <p role="alert" className="text-sm text-danger">{etat.erreur}</p>}
      <Bouton type="submit" chargement={etat.envoi}>Envoyer</Bouton>
    </form>
  )
}

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto max-w-5xl px-6 py-6 flex items-center justify-between">
        <a href="/" className="font-semibold">{"{{NOM}}"}</a>
        <a href="#contact" className="text-sm underline-offset-4 hover:underline">Contact</a>
      </header>
      <main>
        <section className="mx-auto max-w-5xl px-6 py-20">
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight max-w-3xl">{"{{NOM}}"}</h1>
          <p className="mt-6 text-lg text-doux max-w-2xl">{"{{RESUME}}"}</p>
          <a href="#contact" className="mt-8 inline-flex min-h-10 items-center rounded-md bg-primaire px-4 text-sm font-medium text-white hover:opacity-90">Nous écrire</a>
        </section>
        <section id="contact" className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-2xl font-semibold mb-6">Contact</h2>
          <Contact />
        </section>
      </main>
      <footer className="mx-auto max-w-5xl px-6 py-10 text-sm text-doux">© {new Date().getFullYear()} {"{{NOM}}"}</footer>
    </div>
  )
}
