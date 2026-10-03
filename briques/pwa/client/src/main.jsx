import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import App from "./App.jsx"

createRoot(document.getElementById("racine")).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// L'application installable : le service worker (client/public/sw.js), en production seulement.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("Service worker :", e)))
}
