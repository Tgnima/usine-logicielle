import { StrictMode, Suspense, lazy } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import "./posthog.js"
import App from "./App.jsx"

// Chargé à part : le kit ne pèse rien sur les écrans du produit.
const Kit = lazy(() => import("./Kit.jsx"))

// /kit : tous les composants aux couleurs du produit (le kit d'interface, validé sur captures).
createRoot(document.getElementById("racine")).render(
  <StrictMode>
    {location.pathname === "/kit" ? <Suspense><Kit /></Suspense> : <App />}
  </StrictMode>,
)
