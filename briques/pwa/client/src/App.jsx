// Le point de départ de l'application mobile : un en-tête, le contenu, une barre
// de navigation en bas, et un bandeau quand le réseau manque. Les tâches de l'usine
// remplacent le contenu par le vrai produit, avec les composants de client/src/ui.
import { useEffect, useState } from "react"
import { Carte } from "./ui/index.jsx"

function useEnLigne() {
  const [enLigne, setEnLigne] = useState(typeof navigator === "undefined" ? true : navigator.onLine)
  useEffect(() => {
    const maj = () => setEnLigne(navigator.onLine)
    window.addEventListener("online", maj)
    window.addEventListener("offline", maj)
    return () => {
      window.removeEventListener("online", maj)
      window.removeEventListener("offline", maj)
    }
  }, [])
  return enLigne
}

// La navigation principale, sous le pouce. 3 à 5 entrées.
export function BarreBas({ liens, actif }) {
  return (
    <nav aria-label="Navigation principale" className="fixed inset-x-0 bottom-0 border-t border-black/10 bg-surface pb-[env(safe-area-inset-bottom)]">
      <ul className="mx-auto flex max-w-lg">
        {liens.map((l) => (
          <li key={l.href} className="flex-1">
            <a
              href={l.href}
              aria-current={l.href === actif ? "page" : undefined}
              className={`flex min-h-14 flex-col items-center justify-center text-xs ${l.href === actif ? "font-semibold text-texte" : "text-doux"}`}
            >
              {l.libelle}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default function App() {
  const enLigne = useEnLigne()
  return (
    <div className="min-h-dvh bg-fond pb-20">
      <header className="sticky top-0 z-10 border-b border-black/10 bg-surface/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur">
        <h1 className="mx-auto flex h-14 max-w-lg items-center text-lg font-semibold">{"{{NOM}}"}</h1>
      </header>
      {!enLigne && (
        <p role="status" className="bg-alerte px-4 py-2 text-center text-sm text-white">
          Hors ligne : les dernières données affichées peuvent dater.
        </p>
      )}
      <main className="mx-auto grid max-w-lg gap-4 px-4 py-4">
        <Carte titre="L'application se construit">
          <p className="text-sm text-doux">{"{{RESUME}}"}</p>
        </Carte>
      </main>
      <BarreBas liens={[{ href: "/", libelle: "Accueil" }]} actif="/" />
    </div>
  )
}
