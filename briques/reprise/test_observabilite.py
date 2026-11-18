"""Le module d'observabilité des dépôts Python repris (observabilite.py) : le même masquage que
l'usine, un pouls de compteurs seulement, l'état des envois pour la sonde, et rien qui bloque.
Lancer : python3 -m unittest -v briques/reprise/test_observabilite.py
Les tests avec sentry-sdk sont sautés s'il n'est pas installé."""

import errno
import importlib.util
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ICI = Path(__file__).resolve().parent
sys.path.insert(0, str(ICI))
import observabilite as obs  # noqa: E402

ENV = {"SENTRY_DSN": "https://clepublique@o1.ingest.de.sentry.io/2", "POSTHOG_TOKEN": "phc_jetondetestjetondetest1234", "USINE_PRODUIT": "mon-produit", "USINE_ENVIRONNEMENT": "apercu", "USINE_VERSION": "94f260e5a1b2"}


class FauxEnvoi:
    def __init__(self, code=200, erreur=None):
        self.appels = []
        self.code = code
        self.erreur = erreur

    def __call__(self, url, corps, entetes, delai_s):
        self.appels.append({"url": url, "corps": corps, "entetes": entetes})
        if self.erreur:
            raise self.erreur
        return self.code, {}


class Masquage(unittest.TestCase):
    def test_meme_masquage_que_l_usine(self):
        cas = json.loads((ICI / "cas-masquage.json").read_text(encoding="utf-8"))["cas"]
        self.assertGreater(len(cas), 10)
        for c in cas:
            with self.subTest(entree=c["entree"][:40]):
                self.assertEqual(obs.nettoyer(c["entree"], c.get("maximum", 1000)), c["sortie"])

    def test_compteurs_surs(self):
        self.assertEqual(obs.compteurs_surs({"en_attente": 3, "actif": True, "vide": None, "nom": "Léa Martin", "liste": [1], "Majuscule": 1, "infini": float("inf")}), {"en_attente": 3, "actif": True, "vide": None})

    def test_lire_dsn(self):
        self.assertEqual(obs.lire_dsn(ENV["SENTRY_DSN"]), {"cle": "clepublique", "projet": "2", "base": "https://o1.ingest.de.sentry.io/api/2"})
        self.assertEqual(obs.lire_dsn("http://cle@localhost:4301/1")["base"], "http://localhost:4301/api/1")
        self.assertIsNone(obs.lire_dsn("pas un dsn"))
        self.assertIsNone(obs.lire_dsn("https://o1.ingest.de.sentry.io/2"))


class Pouls(unittest.TestCase):
    def test_un_evenement_posthog_de_compteurs_etiquete_par_le_produit(self):
        f = FauxEnvoi()
        o = obs.Observabilite(env=ENV, envoyer=f, signaler=lambda t: None)
        o.ajouter_pouls(lambda: {"en_attente": 4, "client": "Léa Martin"})
        o.ajouter_pouls(lambda: {"envois_ok": 12})
        self.assertTrue(o.envoyer_pouls())
        appel = f.appels[0]
        self.assertEqual(appel["url"], "https://eu.i.posthog.com/batch/")
        corps = json.loads(appel["corps"])
        self.assertEqual(corps["api_key"], ENV["POSTHOG_TOKEN"])
        e = corps["batch"][0]
        self.assertEqual((e["event"], e["distinct_id"]), ("pouls", "produit:mon-produit"))
        p = e["properties"]
        self.assertEqual((p["produit"], p["environnement"], p["version"], p["en_attente"], p["envois_ok"]), ("mon-produit", "apercu", "94f260e5a1b2", 4, 12))
        self.assertIs(p["$process_person_profile"], False)
        self.assertIs(p["$geoip_disable"], True)
        self.assertNotIn("client", p)
        self.assertNotIn(b"L\xc3\xa9a", appel["corps"])

    def test_l_etat_des_envois_dit_la_reponse_du_dernier_jamais_la_cle(self):
        f = FauxEnvoi()
        o = obs.Observabilite(env=ENV, envoyer=f, signaler=lambda t: None)
        self.assertTrue(o.envoyer_pouls())
        f.code = 401
        self.assertFalse(o.envoyer_pouls())
        e = o.etat()
        self.assertEqual((e["contrat"], e["pile"], e["demarre"]), (1, "python", False))
        self.assertEqual((e["posthog"]["actif"], e["posthog"]["envoyes"], e["posthog"]["echecs"], e["posthog"]["dernier_echec"]["raison"]), (True, 1, 1, "HTTP 401"))
        self.assertRegex(e["posthog"]["dernier_ok"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertNotIn("phc_", json.dumps(e))
        self.assertNotIn("clepublique", json.dumps(e))

    def test_un_service_injoignable_ne_bloque_rien(self):
        o = obs.Observabilite(env=ENV, envoyer=FauxEnvoi(erreur=ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused")), signaler=lambda t: None)
        self.assertFalse(o.envoyer_pouls())
        self.assertEqual(o.etat()["posthog"]["dernier_echec"]["raison"], "ECONNREFUSED")

    def test_sans_cle_rien_ne_demarre(self):
        o = obs.Observabilite(env={"USINE_PRODUIT": "mon-produit"}, envoyer=FauxEnvoi(), signaler=lambda t: None)
        o.demarrer()
        e = o.etat()
        self.assertEqual((e["demarre"], e["sentry"]["actif"], e["posthog"]["actif"]), (False, False, False))

    def test_le_premier_pouls_part_au_delai_demande(self):
        f = FauxEnvoi()
        o = obs.Observabilite(env={"POSTHOG_TOKEN": ENV["POSTHOG_TOKEN"], "USINE_PRODUIT": "mon-produit", "USINE_PREMIER_POULS_S": "1"}, envoyer=f, signaler=lambda t: None)
        o.demarrer()
        fin = time.monotonic() + 5
        while not f.appels and time.monotonic() < fin:
            time.sleep(0.05)
        self.assertEqual(len(f.appels), 1)
        self.assertTrue(o.etat()["demarre"])


class AvantEnvoi(unittest.TestCase):
    def test_masque_retire_la_requete_et_ne_repete_pas(self):
        o = obs.Observabilite(env=ENV, envoyer=FauxEnvoi(), signaler=lambda t: None)

        def evenement(n):
            return {
                "exception": {"values": [{"type": "ValueError", "value": f"envoi à lea.martin@exemple.fr refusé après {n} essais", "stacktrace": {"frames": [{"filename": "app.py", "vars": {"mdp": "x"}, "context_line": "x = 1"}]}}]},
                "request": {"method": "POST", "url": "https://app.exemple.test/api/prets?email=lea@exemple.fr", "data": {"nom": "Léa"}, "cookies": "s=1", "headers": {"Cookie": "s=1"}},
                "user": {"email": "lea@exemple.fr"},
                "breadcrumbs": {"values": [{"message": "Léa"}]},
            }

        e = o._avant_envoi(evenement(3))
        valeur = e["exception"]["values"][0]
        self.assertEqual(valeur["value"], "envoi à [email] refusé après 3 essais")
        self.assertNotIn("vars", valeur["stacktrace"]["frames"][0])
        self.assertNotIn("context_line", valeur["stacktrace"]["frames"][0])
        self.assertEqual(e["request"], {"method": "POST", "url": "https://app.exemple.test/api/prets"})
        self.assertNotIn("user", e)
        self.assertNotIn("breadcrumbs", e)
        # La même erreur (aux chiffres près) ne repart pas dans l'heure.
        self.assertIsNone(o._avant_envoi(evenement(4)))
        self.assertEqual(o.etat()["sentry"]["ignorees"], 1)


@unittest.skipIf(importlib.util.find_spec("sentry_sdk") is None, "sentry-sdk n'est pas installé")
class AvecSentrySdk(unittest.TestCase):
    """Une vraie exception, par sentry-sdk, jusqu'à un faux Sentry local : l'enveloppe arrive et
    l'état dit qu'elle a été acceptée."""

    def test_une_exception_arrive_masquee_et_l_etat_le_dit(self):
        recus = []

        class Capteur(BaseHTTPRequestHandler):
            def do_POST(self):
                recus.append((self.path, self.headers.get("x-sentry-auth", ""), self.rfile.read(int(self.headers.get("content-length") or 0))))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *a):
                pass

        serveur = HTTPServer(("127.0.0.1", 0), Capteur)
        threading.Thread(target=serveur.serve_forever, daemon=True).start()
        import sentry_sdk

        try:
            env = {**ENV, "SENTRY_DSN": f"http://clepublique@127.0.0.1:{serveur.server_port}/7", "POSTHOG_TOKEN": ""}
            o = obs.Observabilite(env=env, envoyer=obs._envoyer_urllib, signaler=lambda t: None)
            o.demarrer()
            self.assertTrue(o.etat()["sentry"]["pret"])
            self.assertTrue(o.etat()["sentry"]["suivi"], "le transport de l'usine voit la réponse de Sentry")
            try:
                {}["plan"]
            except KeyError as exc:
                self.assertTrue(o.signaler_erreur(exc))
            sentry_sdk.flush(5)
            fin = time.monotonic() + 5
            while o.etat()["sentry"]["envoyees"] < 1 and time.monotonic() < fin:
                time.sleep(0.05)
            self.assertEqual(o.etat()["sentry"]["envoyees"], 1)
            chemin, auth, corps = recus[0]
            self.assertEqual(chemin, "/api/7/envelope/")
            self.assertIn("sentry_key=clepublique", auth)
            evenement = json.loads(corps.split(b"\n")[2])
            self.assertEqual(evenement["exception"]["values"][-1]["type"], "KeyError")
            self.assertEqual((evenement["environment"], evenement["release"], evenement["tags"]["produit"]), ("apercu", "mon-produit@94f260e5a1b2", "mon-produit"))
            self.assertNotIn("vars", json.dumps(evenement))
        finally:
            sentry_sdk.init()
            serveur.shutdown()


if __name__ == "__main__":
    os.environ.pop("PYTEST_CURRENT_TEST", None)
    unittest.main()
