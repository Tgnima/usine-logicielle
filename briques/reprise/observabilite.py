"""L'observabilité d'un produit Python repris par l'usine logicielle.

Ses erreurs vers Sentry (sentry-sdk), son pouls vers PostHog (urllib, sans autre dépendance), et
l'état de ces envois pour la sonde de l'usine. Côté serveur seulement. Les clés viennent de l'usine
(SENTRY_DSN, POSTHOG_TOKEN, POSTHOG_HOTE), avec le nom du produit (USINE_PRODUIT), son environnement
(USINE_ENVIRONNEMENT : apercu ou production) et sa version (USINE_VERSION). Sans clé, rien ne part.
Un envoi ne bloque jamais le produit : tout part en arrière-plan, une erreur d'envoi est ignorée.

Ce qui part :
  - les exceptions non attrapées, celles des requêtes (intégrations de sentry-sdk) et chaque
    logging.error : le type, le message masqué et la pile, sans variables locales, sans code
    source, sans corps ni en-têtes de requête ;
  - toutes les 5 minutes, un événement « pouls » : des COMPTEURS seulement (nombres et booléens),
    jamais un texte saisi, un nom, une adresse.

À brancher au démarrage de l'application, avant de servir (dépendance : sentry-sdk) :

    from usine.observabilite import demarrer_observabilite, etat_observabilite
    demarrer_observabilite()

puis une route GET /_usine/observabilite qui répond etat_observabilite() en JSON : la sonde de
l'usine la lit chaque minute, sur le réseau du produit, et Caddy ne la sert jamais au public.

    # Flask                                   # FastAPI
    @app.get("/_usine/observabilite")         @app.get("/_usine/observabilite")
    def observabilite():                      def observabilite():
        return etat_observabilite()               return etat_observabilite()

Ajouter un compteur au pouls : ajouter_pouls(lambda: {"en_retard": compter_en_retard()}).
Signaler une erreur attrapée : signaler_erreur(exc).
Sous gunicorn avec plusieurs workers, chacun envoie son pouls.

Ne modifie pas ce fichier : l'usine le dépose tel quel et vérifie qu'il est intact. Le masquage des
données personnelles y est le même que celui de l'usine (cas-masquage.json, vérifié par ses tests).
"""

import errno
import importlib.util
import json
import logging
import math
import os
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

CONTRAT_OBSERVABILITE = 1
PERIODE_POULS_S = 300
_DEBUT = time.monotonic()

# --- Ce qui ne sort jamais (mêmes motifs que l'usine, commun/observabilite.mjs) ---------------
_A = re.ASCII
_I = re.ASCII | re.IGNORECASE


def _ip6(m):
    return "[ip]" if len(m.group(0)) > 2 else m.group(0)


def _jeton(m):
    t = m.group(0)
    return "[jeton]" if re.search(r"\d", t) and re.search(r"[A-Za-z]", t) else t


MASQUES = [
    (re.compile(r"\x1b\[[0-9;?]*[A-Za-z]", _A), ""),
    (re.compile(r"[\x00-\x08\x0b-\x1f\x7f]", _A), ""),
    (re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeoprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|ph[cx]_[A-Za-z0-9]{16,}|usp_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})", _A), "[secret]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}", _A), "[secret]"),
    (re.compile(r"\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}", _I), r"\1 [secret]"),
    (re.compile(r"""\b(pass(?:word|wd)?|mot_de_passe|mdp|secret|token|jeton|api[_-]?key|apikey|authorization|cookie|dsn)(["']?\s*[:=]\s*["']?)(?!\[secret\])[^\s"'&,;]+""", _I), r"\1\2[secret]"),
    (re.compile(r"\b([a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@", _I), r"\1[secret]@"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}", _A), "[email]"),
    (re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b", _A), "[iban]"),
    (re.compile(r"(?<![\w+])(?:\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}|0[1-9](?:[\s.-]?\d{2}){4})(?!\w)", _A), "[téléphone]"),
    (re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b", _A), "[ip]"),
    (re.compile(r"\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b", _I), "[ip]"),
    (re.compile(r"(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![\w:])", _I), _ip6),
    (re.compile(r"[A-Za-z0-9_-]{24,}", _A), _jeton),
]


def nettoyer(texte, maximum=1000):
    """Un texte qui peut sortir : masqué, sans caractères de contrôle, limité à maximum caractères."""
    t = texte if isinstance(texte, str) else ("" if texte is None else str(texte))
    if len(t) > maximum * 4:
        t = t[: maximum * 4]
    for motif, remplacement in MASQUES:
        t = motif.sub(remplacement, t)
    return t[: maximum - 1] + "…" if len(t) > maximum else t


_CLE_COMPTEUR = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def compteurs_surs(valeurs):
    """Les compteurs du pouls : des nombres et des booléens seulement, sous des noms simples."""
    surs = {}
    for cle, v in list((valeurs or {}).items())[:60]:
        if not isinstance(cle, str) or not _CLE_COMPTEUR.match(cle):
            continue
        if v is None or isinstance(v, bool) or (isinstance(v, (int, float)) and math.isfinite(v)):
            surs[cle] = v
    return surs


def lire_dsn(dsn):
    """Le DSN de Sentry : la clé publique, le projet et l'adresse de base de l'API."""
    try:
        u = urllib.parse.urlsplit(str(dsn or "").strip())
        morceaux = [m for m in u.path.split("/") if m]
        projet = morceaux.pop() if morceaux else ""
        if u.scheme not in ("http", "https") or not u.username or not projet.isdigit() or not u.hostname:
            return None
        hote = u.netloc.rsplit("@", 1)[-1]
        chemin = "/" + "/".join(morceaux) if morceaux else ""
        return {"cle": urllib.parse.unquote(u.username), "projet": projet, "base": f"{u.scheme}://{hote}{chemin}/api/{projet}"}
    except Exception:
        return None


def _maintenant():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class _Refus(Exception):
    pass


def _raison(e):
    """La raison d'un envoi refusé, en quelques mots : un code HTTP ou un délai, jamais une clé."""
    if isinstance(e, _Refus):
        return str(e)
    cause = getattr(e, "reason", e)
    if isinstance(cause, (TimeoutError,)) or "timed out" in str(cause):
        return "délai dépassé"
    numero = getattr(cause, "errno", None)
    if isinstance(numero, int) and numero in errno.errorcode:
        return errno.errorcode[numero].removeprefix("WSA")  # Windows : WSAECONNREFUSED
    return nettoyer(cause, 80)


def _envoyer_urllib(url, corps, entetes, delai_s):
    requete = urllib.request.Request(url, data=corps, headers=entetes, method="POST")
    try:
        with urllib.request.urlopen(requete, timeout=delai_s) as reponse:
            return reponse.status, reponse.headers
    except urllib.error.HTTPError as e:
        return e.code, e.headers


def _memoire_mo():
    try:
        with open("/proc/self/statm", encoding="ascii") as f:
            return round(int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1e6)
    except Exception:
        return None


class _CompteurErreurs(logging.Handler):
    """Chaque logging.error (et au-dessus) depuis le démarrage : un compteur du pouls."""

    def __init__(self, obs):
        super().__init__(level=logging.ERROR)
        self.obs = obs

    def emit(self, record):
        self.obs._erreurs_vues += 1


class Observabilite:
    def __init__(self, env=None, envoyer=None, delai_s=5.0, erreurs_par_heure=20, signaler=None):
        env = os.environ if env is None else env
        self._env = env
        self._envoyer = envoyer or _envoyer_urllib
        self._fourni = envoyer is not None
        self.delai_s = delai_s
        self.erreurs_par_heure = erreurs_par_heure
        self._signaler = signaler or (lambda texte: logging.getLogger("usine.observabilite").warning(texte))
        self._dsn_brut = str(env.get("SENTRY_DSN") or "").strip()
        self._dsn = lire_dsn(self._dsn_brut)
        self._jeton = str(env.get("POSTHOG_TOKEN") or "").strip()
        hote = env.get("POSTHOG_HOTE") or "eu.i.posthog.com"
        self._hote = (hote if re.match(r"^https?://", hote) else f"https://{hote}").rstrip("/")
        self.produit = nettoyer(env.get("USINE_PRODUIT") or "produit", 64)
        e = env.get("USINE_ENVIRONNEMENT")
        self.environnement = e if e in ("apercu", "production") else "developpement"
        self.version = nettoyer(env["USINE_VERSION"], 40) if env.get("USINE_VERSION") else None
        self._sdk = importlib.util.find_spec("sentry_sdk") is not None
        self._verrou = threading.Lock()
        self._comptes = {"erreurs": {"envoyees": 0, "echecs": 0, "ignorees": 0}, "pouls": {"envoyes": 0, "echecs": 0}}
        self._derniers = {"erreurs": {"ok": None, "echec": None}, "pouls": {"ok": None, "echec": None}}
        self._vues = {}
        self._fenetre = [time.time(), 0]
        self._pause_jusqua = 0.0
        self._injoignable = False
        self._sources = []
        self._demarre = False
        self._sentry_demarre = False
        self._suivi = True
        self._erreurs_vues = 0
        self._file = None

    # --- Les envois, en arrière-plan ---------------------------------------------------------
    def _hors_reseau(self):
        """Sous pytest, ou avec USINE_OBSERVABILITE=0, rien ne part (sauf avec un envoyer fourni)."""
        if self._fourni:
            return False
        return bool(os.environ.get("PYTEST_CURRENT_TEST")) or self._env.get("USINE_OBSERVABILITE") == "0"

    def _poster(self, canal, url, corps, entetes):
        try:
            code, entetes_reponse = self._envoyer(url, corps, entetes, self.delai_s)
            if code == 429 and canal == "erreurs":
                try:
                    attente = float((entetes_reponse or {}).get("retry-after") or 60)
                except (TypeError, ValueError):
                    attente = 60.0
                self._pause_jusqua = time.time() + attente
            if not 200 <= int(code) < 300:
                raise _Refus(f"HTTP {int(code)}")
            with self._verrou:
                self._comptes[canal]["envoyees" if canal == "erreurs" else "envoyes"] += 1
                self._derniers[canal]["ok"] = _maintenant()
                retabli, self._injoignable = self._injoignable, False
            if retabli:
                self._signaler("Observabilité : envois rétablis.")
            return True
        except Exception as e:
            with self._verrou:
                self._comptes[canal]["echecs"] += 1
                self._derniers[canal]["echec"] = {"le": _maintenant(), "raison": _raison(e)}
                premier, self._injoignable = not self._injoignable, True
            # Signalé une fois, en avertissement : jamais logging.error, qui repartirait vers Sentry.
            if premier:
                self._signaler(f"Observabilité : envoi impossible ({_raison(e)}) ; les suivants sont ignorés sans bruit.")
            return False

    def _en_fond(self, fonction):
        if self._file is None:
            self._file = queue.Queue(maxsize=100)

            def travailleur():
                while True:
                    f = self._file.get()
                    try:
                        f()
                    except Exception:
                        pass
                    finally:
                        self._file.task_done()

            threading.Thread(target=travailleur, name="usine-observabilite", daemon=True).start()
        try:
            self._file.put_nowait(fonction)
        except queue.Full:
            with self._verrou:
                self._comptes["erreurs"]["ignorees"] += 1

    def _attendre(self, delai_s):
        fin = time.monotonic() + (delai_s or 0)
        while self._file is not None and self._file.unfinished_tasks and time.monotonic() < fin:
            time.sleep(0.05)

    # --- Sentry --------------------------------------------------------------------------------
    def _avant_envoi(self, evenement, _indice=None):
        """Ce qui part vers Sentry : masqué, sans données de requête, une même erreur une fois par heure."""
        try:
            if time.time() < self._pause_jusqua:
                return None
            exceptions = (evenement.get("exception") or {}).get("values") or []
            for v in exceptions:
                if v.get("value") is not None:
                    v["value"] = nettoyer(v["value"], 1000)
                for cadre in (v.get("stacktrace") or {}).get("frames") or []:
                    for cle in ("vars", "pre_context", "context_line", "post_context"):
                        cadre.pop(cle, None)
                    for cle in ("filename", "abs_path", "function", "module"):
                        if isinstance(cadre.get(cle), str):
                            cadre[cle] = nettoyer(cadre[cle], 300)
            entree = evenement.get("logentry") or {}
            for cle in ("message", "formatted"):
                if isinstance(entree.get(cle), str):
                    entree[cle] = nettoyer(entree[cle], 1000)
            if "params" in entree:
                entree["params"] = []
            if isinstance(evenement.get("message"), str):
                evenement["message"] = nettoyer(evenement["message"], 1000)
            requete = evenement.get("request")
            if isinstance(requete, dict):
                url = urllib.parse.urlsplit(str(requete.get("url") or ""))
                evenement["request"] = {"method": requete.get("method"), "url": nettoyer(f"{url.scheme}://{url.netloc}{url.path}" if url.netloc else url.path, 300)}
            for cle in ("user", "breadcrumbs", "extra"):
                evenement.pop(cle, None)
            evenement["server_name"] = self.produit
            dernier = exceptions[-1] if exceptions else {}
            cadres = (dernier.get("stacktrace") or {}).get("frames") or [{}]
            message = (evenement.get("logentry") or {}).get("message") or evenement.get("message")
            cle = re.sub(r"\d+", "#", "¦".join(str(x) for x in (dernier.get("type"), dernier.get("value"), message, cadres[-1].get("filename"))))[:500]
            t = time.time()
            with self._verrou:
                if t - self._fenetre[0] > 3600:
                    self._fenetre = [t, 0]
                if (cle in self._vues and t - self._vues[cle] < 3600) or self._fenetre[1] >= self.erreurs_par_heure:
                    self._comptes["erreurs"]["ignorees"] += 1
                    return None
                self._vues[cle] = t
                if len(self._vues) > 500:
                    self._vues.pop(next(iter(self._vues)))
                self._fenetre[1] += 1
            return evenement
        except Exception:
            return None

    def _transport(self):
        """Le transport de l'usine : il envoie l'enveloppe lui-même et voit la réponse de Sentry.
        Sans la classe Transport de sentry-sdk, celui de sentry-sdk sert, et la réponse n'est pas vue."""
        try:
            from sentry_sdk.transport import Transport
        except Exception:
            return None
        obs = self

        class TransportUsine(Transport):
            def capture_envelope(self, enveloppe):
                # Seulement les erreurs : ni sessions ni rapports du client.
                try:
                    if not any((getattr(i, "type", None) or (getattr(i, "headers", {}) or {}).get("type")) == "event" for i in enveloppe.items):
                        return
                    corps = enveloppe.serialize()
                except Exception:
                    return
                entetes = {"content-type": "application/x-sentry-envelope", "x-sentry-auth": f"Sentry sentry_version=7, sentry_client=usine-produit-python/1, sentry_key={obs._dsn['cle']}"}
                obs._en_fond(lambda: obs._poster("erreurs", f"{obs._dsn['base']}/envelope/", corps, entetes))

            def flush(self, timeout, callback=None):
                obs._attendre(timeout)

            def kill(self):
                pass

            def is_healthy(self):
                return True

        return TransportUsine

    def _demarrer_sentry(self):
        try:
            import sentry_sdk
        except Exception:
            return False
        options = {
            "dsn": self._dsn_brut,
            "environment": self.environnement,
            "release": f"{self.produit}@{self.version}" if self.version else None,
            "server_name": self.produit,
            "before_send": self._avant_envoi,
        }
        # Rien d'autre que l'erreur : ni donnée personnelle, ni variables locales, ni code, ni corps de
        # requête, ni fil d'Ariane. Une version de sentry-sdk qui ne connaît plus l'une de ces options
        # (TypeError) démarre sans elles : les valeurs par défaut ne gardent rien de personnel, et
        # _avant_envoi retire de toute façon la requête, l'utilisateur et le fil d'Ariane.
        prudentes = {"send_default_pii": False, "include_local_variables": False, "include_source_context": False, "max_request_body_size": "never", "max_breadcrumbs": 0}
        transport = self._transport()
        self._suivi = transport is not None
        for essai in ({**options, **prudentes, **({"transport": transport} if transport else {})}, {**options, **({"transport": transport} if transport else {})}, options):
            try:
                sentry_sdk.init(**essai)
                if "transport" not in essai:
                    self._suivi = False
                sentry_sdk.set_tag("produit", self.produit)
                sentry_sdk.set_tag("service", self.produit)
                return True
            except TypeError:
                continue  # une option inconnue de cette version de sentry-sdk
            except Exception:
                return False
        return False

    def signaler_erreur(self, erreur=None, message=None, niveau="error"):
        """Une erreur attrapée qui mérite d'être vue. Renvoie True si elle part vers Sentry."""
        if not self._sentry_demarre:
            return False
        try:
            import sentry_sdk

            if erreur is not None:
                return sentry_sdk.capture_exception(erreur) is not None
            if message:
                return sentry_sdk.capture_message(nettoyer(message, 1000), level=niveau) is not None
        except Exception:
            pass
        return False

    # --- Le pouls ------------------------------------------------------------------------------
    def ajouter_pouls(self, fonction):
        self._sources.append(fonction)

    def envoyer_pouls(self):
        if not self._jeton or self._hors_reseau():
            return False
        compteurs = {}
        echecs = 0
        for f in list(self._sources):
            try:
                compteurs.update(compteurs_surs(f()))
            except Exception as e:
                echecs += 1
                self.signaler_erreur(e)
        # Ni profil de personne, ni géolocalisation (PostHog la déduirait de l'adresse du serveur).
        proprietes = {
            "produit": self.produit,
            "environnement": self.environnement,
            **({"version": self.version} if self.version else {}),
            **compteurs,
            "pouls_echecs": echecs,
            "erreurs_depuis_demarrage": self._erreurs_vues,
            "en_marche_s": round(time.monotonic() - _DEBUT),
            "memoire_mo": _memoire_mo(),
            "$process_person_profile": False,
            "$geoip_disable": True,
        }
        corps = json.dumps({"api_key": self._jeton, "batch": [{"event": "pouls", "distinct_id": f"produit:{self.produit}", "timestamp": _maintenant(), "properties": proprietes}]}).encode("utf-8")
        return self._poster("pouls", f"{self._hote}/batch/", corps, {"content-type": "application/json"})

    # --- Le démarrage --------------------------------------------------------------------------
    def demarrer(self, premier_pouls_s=None):
        """Les erreurs vers Sentry, puis le pouls toutes les 5 min (le premier après 30 s)."""
        if self._demarre or (not self._dsn and not self._jeton) or self._hors_reseau():
            return
        self._demarre = True
        logging.getLogger().addHandler(_CompteurErreurs(self))
        if self._dsn and self._sdk:
            self._sentry_demarre = self._demarrer_sentry()
        if self._jeton:
            if premier_pouls_s is None:
                try:
                    premier_pouls_s = float(self._env.get("USINE_PREMIER_POULS_S") or 30)
                except ValueError:
                    premier_pouls_s = 30.0
                if not 1 <= premier_pouls_s <= 300:
                    premier_pouls_s = 30.0

            def battre():
                time.sleep(premier_pouls_s)
                while True:
                    try:
                        self.envoyer_pouls()
                    except Exception:
                        pass
                    time.sleep(PERIODE_POULS_S)

            threading.Thread(target=battre, name="usine-pouls", daemon=True).start()

    def etat(self):
        """Ce que la sonde de l'usine lit (GET /_usine/observabilite) : des comptes et des dates, jamais une clé."""
        with self._verrou:
            erreurs = dict(self._comptes["erreurs"])
            pouls = dict(self._comptes["pouls"])
            derniers = {c: dict(v) for c, v in self._derniers.items()}
        sentry_pret = self._sentry_demarre if self._demarre else self._sdk
        return {
            "contrat": CONTRAT_OBSERVABILITE,
            "pile": "python",
            "demarre": self._demarre,
            "en_marche_s": round(time.monotonic() - _DEBUT),
            "erreurs_depuis_demarrage": self._erreurs_vues,
            # pret : False quand la clé est là mais que sentry-sdk manque, ou n'a pas pu démarrer.
            "sentry": {"actif": bool(self._dsn), "pret": bool(self._dsn) and bool(sentry_pret), "suivi": self._suivi, **erreurs, "dernier_ok": derniers["erreurs"]["ok"], "dernier_echec": derniers["erreurs"]["echec"]},
            "posthog": {"actif": bool(self._jeton), "pret": True, "suivi": True, **pouls, "dernier_ok": derniers["pouls"]["ok"], "dernier_echec": derniers["pouls"]["echec"]},
        }


# --- L'instance du produit (créée au premier appel : les variables sont lues à ce moment) -------
_instance = None
_verrou_instance = threading.Lock()


def _obs():
    global _instance
    with _verrou_instance:
        if _instance is None:
            _instance = Observabilite()
        return _instance


def demarrer_observabilite(premier_pouls_s=None):
    _obs().demarrer(premier_pouls_s)


def ajouter_pouls(fonction):
    _obs().ajouter_pouls(fonction)


def signaler_erreur(erreur=None, message=None):
    return _obs().signaler_erreur(erreur, message=message)


def etat_observabilite():
    return _obs().etat()


__all__ = ["CONTRAT_OBSERVABILITE", "Observabilite", "ajouter_pouls", "compteurs_surs", "demarrer_observabilite", "etat_observabilite", "lire_dsn", "nettoyer", "signaler_erreur"]
