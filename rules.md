# Règles du projet

Boutique de mineurs (machines de minage) pour Les Chauffagistes : achat de lots en gros, revente à l'unité. Le fonctionnement métier est décrit dans `specs.md`, le schéma relationnel dans `schema.dbml`. En cas de contradiction, `specs.md` fait foi pour le métier, `schema.dbml` pour les données (et doit alors être corrigé).

## Contraintes techniques
- Base de données : PostgresSQL
- ORM : Prisma
- Composants à privilégier : Ag Grid, MUI Charts
- Compatible Docker Swarm (multi environnement, multi node)
- Testabilité via tests d'intégration et unitaires
- Tests de bout en bout : Playwright (`@playwright/test`, config dans `playwright.config.ts`, `npm run e2e`, scénarios dans `e2e/`)

### Précisions
- Framework : Next.js (App Router). Cette version a des changements cassants : lire le guide concerné dans `node_modules/next/dist/docs/` avant d'écrire du code (voir `AGENTS.md`).
- Docker Swarm : application sans état local (pas de fichier ou de session stockés sur le disque du conteneur), configuration par variables d'environnement ou secrets Swarm, endpoint de healthcheck, migrations Prisma lancées par une étape dédiée (jamais au démarrage de chaque réplique), logs sur stdout.
- Montants : entiers en centimes (bigint), devise unique : l'euro (pas de colonne devise). Aucun `float` pour l'argent.
- Les transitions de statut d'un lot sont validées côté serveur, dans une seule fonction de domaine. L'UI n'est jamais la seule garde.
- Toute opération multi-tables (attribution d'une machine, passage de précommande à commande, changement de statut) est transactionnelle et résiste à la concurrence (le stock ne peut pas être survendu).
- Langue : interface et textes en français. Code, noms de variables, tables et commits en anglais.

## UI/UX :
- Pro épuré, style Apple Store, couleur d'accent orange
- Les grilles du backoffice utilisent Ag Grid, les graphiques MUI Charts
- Accessibilité de base : contrastes suffisants (attention au texte blanc sur orange), navigation clavier, états de chargement, d'erreur et vides traités
- Un écran backoffice doit permettre de réaliser l'action métier en peu de clics, avec le statut du lot et la prochaine action visibles

## Intégration avec les microservices existants
- L'authentification fonctionne avec auth-service-back et auth-service-front (disponibles dans le répertoire parent ../)
- Le registre privé verdaccio ne fonctionne pas pour le moment, donc la lib de code partagée chauff-cmn peut ne pas être installable dans l'immédiat. Remplacer par son emplacement sur le disque : /Users/hugo/Code/chauffagistes/chauff-cmn
- `User.auth_user_id` référence l'identifiant du service d'auth. La boutique ne stocke ni mot de passe ni session propre.
- Ne jamais modifier les services voisins depuis ce dépôt. Si un changement y est nécessaire, le signaler à Hugo.

## Backoffice
- Accès via une whitelist de user_id
- Pas de système de permission complexe. Accès complet ou rien
- La whitelist est lue depuis la configuration (variable d'environnement), pas depuis la base. Elle est vérifiée côté serveur sur chaque route et chaque action du backoffice.

## Paiement et données sensibles
- Paiement privilégié en Bitcoin (voir `specs.md`, statut Précommande). Le mode de rapprochement paiement/commande n'est pas défini : c'est une question ouverte, à ne pas deviner.
- Données personnelles (adresses de facturation et de livraison) : ne jamais les logger, ne les exposer qu'à l'utilisateur concerné et au backoffice.
- Aucun secret dans le dépôt. Fichier `.env.example` à jour.

## Organisation du travail

### Principe
Claude (session principale) joue le rôle de **Gestion de projet** : il découpe le travail en jalons, délègue aux agents spécialisés (définis dans `.claude/agents/`), arbitre et rend compte à Hugo. Les agents ne se parlent pas directement : tout passe par l'orchestrateur.

### Équipe
| Agent | Fichier | Écrit du code ? | Produit |
|---|---|---|---|
| Gestion de projet | (session principale) | Non | `docs/roadmap.md`, découpage des tâches |
| Designeur de base de données | `db-designer` | `schema.dbml`, `prisma/` | schéma, migrations, seed |
| Développeur backend | `backend-dev` | Oui (`src/app/api`, `src/server`) | routes, logique de domaine |
| Développeur frontend | `frontend-dev` | Oui (UI) | pages, composants |
| Dev qualité | `quality-dev` | Tests, et corrections de qualité | tests, rapports de dette |
| Agent logistique | `logistics-agent` | Non | revue des workflows (`docs/reviews/`) |
| Client test | `customer-tester` | Non | scénarios et bugs (`docs/reviews/`) |
| Logisticien test | `logistician-tester` | Non | scénarios et bugs (`docs/reviews/`) |

Les agents de revue et de test n'écrivent que dans `docs/reviews/` (et leurs scénarios Playwright dans `e2e/customer/` ou `e2e/backoffice/` pour les deux testeurs). Ils signalent, ils ne corrigent pas. Ces rapports, leurs captures et les scénarios d'exploration des testeurs restent locaux (ignorés par git) : seules les décisions retenues vont dans `docs/roadmap.md` et les tests utiles dans `e2e/` et `tests/`.

### Boucle de travail d'un jalon
1. **Cadrage** (gestion de projet) : objectif, périmètre, critères d'acceptation, rédigés dans `docs/roadmap.md`.
2. **Revue métier** (agent logistique) : le workflow prévu est-il cohérent avec `specs.md` et praticable au quotidien ?
3. **Données** (designeur BDD) : le schéma permet-il le workflow ? Migration prête avant le backend.
4. **Implémentation** : backend d'abord (contrat d'API), puis frontend. Les deux peuvent avancer en parallèle une fois le contrat figé.
5. **Tests** (dev qualité) : tests unitaires et d'intégration sur le périmètre du jalon.
6. **Recette** (client test, logisticien test) : parcours de bout en bout, bugs consignés dans `docs/reviews/`.
7. **Revue qualité** (dev qualité) : doublons, sur-ingénierie, travaux inachevés.
8. **Clôture** : l'orchestrateur résume à Hugo ce qui est fait, ce qui reste, et les décisions à prendre.

Les étapes 2 et 3 peuvent se faire en parallèle, ainsi que 6 pour les deux testeurs. Ne pas lancer d'agent sur une tâche qu'on peut faire en deux lectures.

### Définition de « terminé »
- Les critères d'acceptation du jalon sont satisfaits et démontrés (test ou parcours rejoué).
- `npm run lint`, la vérification de types et les tests passent.
- Aucun `TODO`, code mort, mock ou route factice laissé sans entrée dans `docs/roadmap.md`.
- Une seule implémentation par responsabilité (pas de doublon entre `src/` et un autre emplacement).
- `schema.dbml` et `prisma/schema.prisma` décrivent le même modèle.

### Règles de collaboration
- Un agent ne modifie pas le périmètre d'un autre : il le signale à l'orchestrateur.
- Une question métier non tranchée par `specs.md` est remontée à Hugo, pas inventée. Elle est notée dans « Questions ouvertes » de `docs/roadmap.md`.
- Les rapports sont courts : constat, gravité (bloquant / important / mineur), proposition.
- On avance par petits incréments livrables. Pas d'abstraction pour un besoin hypothétique.

## Jalons proposés
Ordre indicatif, à ajuster avec Hugo.

0. **Fondations** : Prisma + Postgres (Docker Compose local), intégration auth, whitelist backoffice, structure du projet, outillage de tests, healthcheck.
1. **Catalogue** : modèles de mineur, menus d'options et valeurs, pièces associées. CRUD backoffice.
2. **Lots et cycle de vie** : création de lot (brouillon), dérogations et limites d'options, machine à états des statuts, journal des transitions.
3. **Sondage** : publication, fiche produit publique, manifestation d'intérêt (wishlist) sans paiement.
4. **Précommande et paiement** : priorité aux utilisateurs ayant manifesté leur intérêt, contrôle du stock, coordonnées de facturation et de livraison, paiement Bitcoin.
5. **Réception et contrôle** : génération des machines du lot, saisie des numéros de série, état fonctionnel, état des hashboards, attribution aux utilisateurs.
6. **Options, tuning et packaging** : commande du matériel d'options (workflow parallèle), montage, préparation des colis.
7. **Expédition et suivi** : remise au transporteur, lien de suivi, notifications d'avancement aux utilisateurs.
8. **Durcissement** : observabilité, déploiement Swarm, sauvegardes, revue de sécurité.

## Écarts connus entre `specs.md` et `schema.dbml` (à traiter au jalon 0 ou 1)
- `batch_status` ne couvre pas tous les statuts du métier (Sondage, Précommande, Commande en cours, Attente de réception, Contrôle, Tuning, Packaging).
- Le lot n'a ni quantité, ni prix d'achat, ni prix de revente distinct. Son nom est optionnel alors que le métier prévoit un nom par défaut `{qtt} {modèle}`.
- `Model.hashrate` est optionnel alors que la spec le demande. `Model.hashboard_qtt` et `Model.name` sont conformes.
- `BatchOptionValue` couvre dérogation de prix, quantité maximale et retrait d'option, mais l'équivalence « option retirée » = `enabled = false` est à confirmer.
- Manquent : paiement, coordonnées de facturation et de livraison, commande et suivi du matériel d'options (commandé, en attente, livré), suivi du transporteur, historique des statuts, adresse de l'utilisateur.
- La spec parle d'une précommande sans argent (intérêt) puis d'une précommande payante : le schéma n'a qu'une Wishlist et un Claim, la frontière paiement/claim est à définir.
- La spec impose qu'un défaut existe toujours par option : à garantir en base ou en domaine (aujourd'hui rien ne l'empêche).
- Le prix de revente conseillé et le prix de lot ne sont pas modélisés dans `Batch.unit_price` : préciser s'il s'agit du prix de revente.
- `User` n'a pas de champs d'adresse (commentaire laissé en suspens).

## Questions ouvertes
- Rapprochement des paiements Bitcoin : adresse par commande, service externe, validation manuelle ?
- Que devient une précommande si le lot est abandonné après sondage ou précommande (remboursement, délai) ?
- Comment départager les utilisateurs « prioritaires » si la demande dépasse le stock ?
- Un utilisateur peut-il commander plusieurs machines du même lot ?
- Notifications aux utilisateurs : e-mail, dans l'app, les deux ? Un service existant est-il réutilisable ?
