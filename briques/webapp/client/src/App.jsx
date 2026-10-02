// L'écran d'accueil de départ. Les tâches de l'usine le remplacent par le vrai produit.
export default function App() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-xl text-center space-y-4">
        <h1 className="text-4xl font-semibold tracking-tight">{"{{NOM}}"}</h1>
        <p className="text-slate-600">{"{{RESUME}}"}</p>
        <p className="text-xs text-slate-400">Fabriqué par l'usine logicielle</p>
      </div>
    </main>
  )
}
