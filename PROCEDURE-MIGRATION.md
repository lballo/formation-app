# 🚀 Migration vers formation.lauraballo.com — Procédure complète

**Objectif :** séparer l'application Qualiopi (repo `formation-app`, domaine
`formation.lauraballo.com`) du site vitrine (`Site_laura_4`, `lauraballo.com`).

**Ordre impératif des phases : 1 → 2 → 3.** Ne supprime rien de l'ancien repo
tant que le nouveau domaine ne répond pas.

⚠️ **Déjà fait par Claude dans Notion** : les 5 colonnes formules de 👥 Participants
(Lien espace stagiaire, émargement, positionnement, satisfaction, éval à froid)
pointent désormais vers `formation.lauraballo.com`. Elles fonctionneront dès la
fin de la Phase 1 — n'envoie pas de lien à un stagiaire avant.

---

## Phase 1 — Créer et déployer formation-app (~15 min)

### 1.1 Créer le repo GitHub
Sur github.com : **New repository** → nom `formation-app` → privé → sans README.

### 1.2 Pousser le code
```bash
# dézipper formation-app.zip, puis :
cd formation-app
git init
git add .
git commit -m "Application Qualiopi : espace stagiaire, émargement, formulaires, dashboard"
git branch -M main
git remote add origin https://github.com/lballo/formation-app.git
git push -u origin main
```

### 1.3 Créer le projet Vercel
Vercel → **Add New… → Project** → importer `formation-app` →
Framework Preset : **Other** → **Deploy** (ne touche à rien d'autre).

### 1.4 Variables d'environnement
Projet formation-app → **Settings → Environment Variables** — les mêmes valeurs
que sur le projet du site (copie-les depuis Site_laura_4 → Settings → Env Variables) :

| Nom | Valeur |
| --- | --- |
| `NOTION_API_KEY` | le jeton de l'intégration « Laura ballo article process » |
| `DASHBOARD_SECRET` | ta clé d'accès au dashboard |

Puis **Deployments → ⋯ → Redeploy** (obligatoire).

### 1.5 Brancher le domaine formation.lauraballo.com
Projet formation-app → **Settings → Domains** → saisir `formation.lauraballo.com` → Add.

- **Si le DNS de lauraballo.com est géré chez Vercel** (domaine visible dans
  l'onglet Domains du compte) : Vercel configure tout seul → statut « Valid » en ~1 min.
- **Si le DNS est chez ton registrar** (OVH, Gandi, Ionos…) : Vercel affiche
  l'enregistrement à créer. Chez le registrar, zone DNS de lauraballo.com,
  ajoute : `CNAME` | nom `formation` | cible `cname.vercel-dns.com` → attends
  la propagation (souvent < 15 min) → le statut passe à « Valid » et le
  certificat HTTPS est émis automatiquement.

### 1.6 Tests de validation
1. `https://formation.lauraballo.com/api/espace` → `{"error":"Token manquant"}`
2. `https://formation.lauraballo.com/espace/` → page « Lien invalide »
3. Dans Notion 👥 Participants : ouvrir le **Lien espace stagiaire** du
   participant test → le portail s'affiche ✓
4. Signer un émargement + soumettre la satisfaction depuis l'espace →
   les cases se cochent dans Notion ✓
5. `https://formation.lauraballo.com/admin/` → clé → dashboard ✓

**Tant que le point 3 ne passe pas, ne pas faire la Phase 2.**

---

## Phase 2 — Nettoyer Site_laura_4 (~5 min)

### 2.1 Supprimer les fichiers migrés
```bash
cd ~/chemin/vers/Site_laura_4
git rm -r espace emargement positionnement evaluation-froid admin satisfaction-formation
git rm api/espace.js api/emargement.js api/positionnement.js api/eval-froid.js api/dashboard.js api/satisfaction-formation.js
```
**Ne supprime PAS** : `formations/` (catalogue = marketing, il reste sur le site),
ni `api/satisfaction.js`, `api/chat.js`, `api/subscribe.js` (fonctions du site).

### 2.2 Rediriger les anciennes URLs (filet de sécurité)
Au cas où un ancien lien circule (email, favori), on redirige vers le nouveau
domaine en conservant le `?token=`. Dans `vercel.json` du site, ajoute ces
entrées **au début du tableau `"redirects"`** existant :

```json
{ "source": "/espace/:path*", "destination": "https://formation.lauraballo.com/espace/:path*", "statusCode": 308 },
{ "source": "/emargement/:path*", "destination": "https://formation.lauraballo.com/emargement/:path*", "statusCode": 308 },
{ "source": "/positionnement/:path*", "destination": "https://formation.lauraballo.com/positionnement/:path*", "statusCode": 308 },
{ "source": "/evaluation-froid/:path*", "destination": "https://formation.lauraballo.com/evaluation-froid/:path*", "statusCode": 308 },
{ "source": "/satisfaction-formation", "destination": "https://formation.lauraballo.com/satisfaction-formation", "statusCode": 308 },
{ "source": "/admin/:path*", "destination": "https://formation.lauraballo.com/admin/:path*", "statusCode": 308 },
```
(Les redirections Vercel conservent automatiquement les paramètres d'URL,
donc les tokens suivent.)

### 2.3 Pousser
```bash
git add -A
git commit -m "chore: application Qualiopi migrée vers formation.lauraballo.com"
git push
```

### 2.4 Vérifier
- `https://lauraballo.com/satisfaction-formation?token=XXX` → redirige vers
  formation.lauraballo.com avec le token ✓
- Le site vitrine (accueil, blog, /formations/) fonctionne normalement ✓

---

## Phase 3 — Rangement final (2 min)

- Sur Vercel, projet **Site_laura_4** : supprimer la variable `DASHBOARD_SECRET`
  (elle ne sert plus que sur formation-app). `NOTION_API_KEY` peut rester si
  d'autres fonctions du site l'utilisent (pipeline articles) — dans le doute, laisse-la.
- Mémo des nouvelles URLs :

| Usage | URL |
| --- | --- |
| Espace stagiaire (⭐ lien à envoyer) | `https://formation.lauraballo.com/espace/?token={id}` |
| Interface formatrice | `https://formation.lauraballo.com/admin/` |
| Émargement / Positionnement / Satisfaction / Éval à froid | mêmes chemins, nouveau domaine |
| Catalogue public | `https://lauraballo.com/formations/` (inchangé) |

---

## Architecture finale

```
lauraballo.com  (repo Site_laura_4)          formation.lauraballo.com  (repo formation-app)
├── site vitrine, blog, catalogue            ├── espace/  emargement/  positionnement/
├── pipeline articles Notion→publish.py      ├── evaluation-froid/  satisfaction-formation/
└── api/ chat, subscribe, satisfaction(app)  ├── admin/
                                             └── api/ espace, emargement, positionnement,
        ↘ redirections 308 ↗                        eval-froid, satisfaction-formation, dashboard
                                                          ↕
                                             Notion (mêmes bases, même intégration)
```

Bénéfice : tu peux modifier ton site sans jamais risquer l'application de
formation, et inversement. Les preuves Qualiopi (signatures, questionnaires)
vivent sur une infrastructure stable et dédiée.
