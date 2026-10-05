// Le rendu d'une vidéo de présentation, dans le vérificateur (Chromium + ffmpeg) :
// la page film.html est filmée image par image (30 i/s), puis assemblée en MP4.
//   node rendre.cjs <dossier>   (le dossier contient film.html ; sortie : film.mp4)
const { chromium } = require("playwright")
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const dossier = process.argv[2]
const IPS = 30

;(async () => {
  const images = path.join(dossier, "images")
  fs.rmSync(images, { recursive: true, force: true })
  fs.mkdirSync(images, { recursive: true })
  const navigateur = await chromium.launch()
  const page = await navigateur.newPage({ viewport: { width: 1920, height: 1080 } })
  await page.goto(`file://${path.join(dossier, "film.html")}?capture=1`)
  await page.evaluate(() => document.fonts.ready).catch(() => {})
  await page.waitForTimeout(800)
  const duree = await page.evaluate(() => window.DUREE)
  const total = Math.round(duree * IPS)
  for (let i = 0; i < total; i++) {
    await page.evaluate((t) => window.rendre(t), i / IPS)
    await page.screenshot({ path: path.join(images, `f${String(i).padStart(5, "0")}.jpg`), type: "jpeg", quality: 88 })
  }
  await navigateur.close()
  const sortie = path.join(dossier, "film.mp4")
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(IPS), "-i", path.join(images, "f%05d.jpg"),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart", sortie])
  fs.rmSync(images, { recursive: true, force: true })
  console.log(`@@ VIDEO_OK ${fs.statSync(sortie).size} ${duree}`)
})().catch((e) => {
  console.log(`@@ VIDEO_ERREUR ${String(e.message).split("\n")[0].slice(0, 300)}`)
  process.exit(1)
})
