// Les formats français, partout pareils : 1 234,50 €, 12 %, 3 oct. 2026.
const nombreFr = new Intl.NumberFormat("fr-FR")

export const nombre = (n, decimales = 0) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: decimales, maximumFractionDigits: decimales }).format(Number(n ?? 0))
export const euros = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(n ?? 0))
export const pourcentage = (x, decimales = 0) => `${nombre(Number(x ?? 0) * 100, decimales)} %`
export const entier = (n) => nombreFr.format(Math.round(Number(n ?? 0)))

export function date(d, { heure = false } = {}) {
  if (!d) return "—"
  const v = new Date(d)
  if (Number.isNaN(v.getTime())) return "—"
  return v.toLocaleString("fr-FR", { day: "numeric", month: "short", year: "numeric", ...(heure ? { hour: "2-digit", minute: "2-digit" } : {}) })
}

// « il y a 3 jours », « dans 2 h » : pour les fils d'activité.
export function relatif(d, maintenant = new Date()) {
  const ecart = (new Date(d).getTime() - maintenant.getTime()) / 1000
  const rtf = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" })
  const pas = [[60, "second"], [3600, "minute"], [86400, "hour"], [604800, "day"], [2629800, "week"], [31557600, "month"], [Infinity, "year"]]
  const div = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 }
  const [, unite] = pas.find(([limite]) => Math.abs(ecart) < limite)
  return rtf.format(Math.round(ecart / div[unite]), unite)
}
