# Roadmap et décisions

**Nouvelle session : commencer par la section « Reprise (à lire en premier dans une nouvelle session) », plus bas dans ce fichier.** Les jalons sont dans `rules.md`. Ce fichier suit l'avancement, les décisions métier de Hugo (source de vérité avec `specs.md`) et les questions ouvertes.

## Décisions métier (Hugo, 2026-10-06)

### Paiement
- Service de paiement Bitcoin maison, une adresse de réception par facture. À écarter du périmètre immédiat si possible : on modélise la commande et son paiement, pas le service.
- On paie toujours la totalité (machine + options), sans acompte.
- Annulation : tout ce qui a été payé est remboursé avec le même moyen de paiement (Bitcoin).

### Stock et précommandes
- Stock théorique d'un lot = nombre de machines achetées (`Batch.quantity`). Chaque précommande payée retire une machine du stock théorique. Les précommandes sont plafonnées par ce stock : la demande ne peut pas le dépasser.
- Une wishlist (intérêt, sans argent) devient une précommande quand l'utilisateur confirme et paie, pendant la phase de précommande.
- Priorité : les utilisateurs ayant manifesté leur intérêt ont 1 jour de priorité à l'ouverture des précommandes. Ensuite, premier arrivé, premier servi.
- Pendant le Tuning (machines reçues et triées), on parle de commandes et non plus de précommandes ; elles restent possibles tant que le stock le permet.
- Un utilisateur peut prendre plusieurs machines d'un même lot. Modélisation à choisir par le designeur : une ligne par machine (une configuration par ligne) est la piste préférée.

### Réservation et paiement tardif (2026-10-06)
- Une facture en attente réserve le stock pendant 30 minutes. Passé ce délai elle expire et libère la place.
- Un paiement reçu après expiration est accepté s'il reste de la place ; sinon la somme reçue est remboursée.
- Garde-fou contre l'accaparement : à définir (piste : une seule facture en attente par utilisateur et par lot, nombre de lignes plafonné).
- Remboursement : on renvoie la somme BTC reçue (montant BTC, pas de conversion).
- Wishlist : autorisée uniquement pendant le sondage.
- Pas de retour arrière du lot vers Sondage ou Brouillon une fois la précommande ouverte.

### Écarts de paiement, remboursements et accaparement (2026-10-06)
- Montant reçu inférieur au montant attendu : on demande l'appoint (la facture reste en attente de complément). Montant supérieur : on rembourse la différence. Le montant attendu en sats doit donc être modélisé et les paiements partiels tracés (jalon 4).
- Frais du réseau Bitcoin sur les remboursements : à la charge de la boutique.
- Remboursement partiel (ligne annulée, rabais) : au prorata de ce qui a été reçu.
- ~~La configuration d'une wishlist reste modifiable après le sondage~~ : remplacé le 2026-10-07, voir « Décisions du jalon 3 » (immuable dès la Précommande).
- Garde-fou anti-accaparement validé : une seule facture en attente vivante par utilisateur et par lot (trigger sous verrou du lot), plafond de lignes par facture ou par utilisateur, délai entre deux factures expirées d'un même utilisateur. Valeurs chiffrées à fixer au jalon 4 (à rendre configurables).

### Options par défaut et menus masqués (2026-10-06)
- La valeur par défaut d'un menu est toujours gratuite (0 €), sans pièce ni action : c'est la machine « brute ». À garantir en base (CHECK/trigger sur prix et pièces de la valeur par défaut).
- Un lot peut masquer un menu entier : la valeur par défaut s'applique d'office, sans choix pour l'utilisateur. Schéma : indicateur par menu et par lot, plus bouton « Masquer ce menu » dans le formulaire de lot. À planifier avec `db-designer` après les correctifs en cours.

### Prix, devise et menus ajoutés (2026-10-06)
- Le prix catalogue d'une valeur d'option est figé dès qu'un lot du modèle est publié (hors brouillon). Pour changer un prix, on passe par une dérogation de lot.
- Devise unique : l'euro. Retirer `currency` du schéma, de l'API et de l'UI.
- Un menu ajouté à un modèle après la publication d'un lot ne s'applique pas aux lots déjà publiés (ils n'ont pas ce menu ; sa valeur par défaut s'applique implicitement).

### Décisions sur le schéma v4 (2026-10-07)
- Le prix catalogue se débloque quand le lot passe `closed` ou `cancelled` (comportement implémenté).
- Masquer un menu au sondage alors que des wishlists y ont fait un choix : ces choix sont ramenés à la valeur par défaut, avec un avertissement à l'admin.
- Menu Avec/Sans : « Sans » est toujours la valeur par défaut (gratuite, sans pièce). « Avec » ne peut jamais être le défaut. Un toggle a exactement deux valeurs, dont l'une est le défaut « Sans ».
- Changer la valeur par défaut d'un menu après publication : autorisé seulement s'il ne change ni une wishlist ni une commande existante.
- Configuration complète : une machine (wishlist ou ligne de commande) porte une valeur pour chaque menu visible, y compris « Sans » à 0 €. Un menu masqué n'a pas de ligne. Une configuration est un instantané qui ne change plus avec le catalogue.
- Valeur ajoutée à un menu après publication d'un lot : l'admin peut la proposer sur ce lot après coup (bouton « Proposer sur ce lot »).
- Options = produits unitaires et irréductibles, achetés tels quels (ex. Silent kit), jamais fabriqués à partir de matériel en stock. L'unité à surveiller est le kit lui-même, et il faut gérer le stock d'options.
- **`Part` est conservée** comme produit physique et unité de stock : un même produit (ex. Silent kit, compatible avec presque tous les appareils) est partagé par les valeurs d'option de plusieurs modèles. Le stock est commun à tous les lots et indépendant d'eux.
- Pour chaque lot, l'admin doit voir combien de chaque produit il faut (demande des configurations du lot), le stock commun disponible, et ce qu'il reste à commander, pour éviter les mauvaises surprises. La décision de commander reste manuelle.
- La règle « défaut sans pièce » est supprimée (le défaut n'a rien à acheter) ; « défaut gratuit » reste.
- **Pression sur le stock d'options** : par produit, pression = demande des lots en cours ÷ stock disponible (ex. 10 kits, deux lots qui en demandent 8 : 16/10). Avertissement au-dessus de 1, avec le manque à commander. Demande ferme = configurations payées + factures en attente non expirées ; demande potentielle = wishlists du sondage, affichée à part. Ne comptent que les lots qui n'ont pas encore consommé leurs kits (un kit monté sort du stock par un mouvement). Distinguer stock physique, kits commandés / en route, demande. Calculé à l'affichage, jamais stocké. Affiché sur la fiche du lot et sur une vue d'ensemble des produits d'options. Pas de palier intermédiaire pour l'instant.
- Reste à concevoir (db-designer) : suivi du stock commun (journal de mouvements : réception, correction manuelle), lien avec `BatchPartOrder` (commandé / attente de livraison / livré) et vue « besoin par lot ».
- Stock d'options, comportements validés par Hugo (2026-10-06) : réception de kits possible sans commande de lot (réassort) ; une seule réception par commande de lot, quantité libre, pas de livraison partielle ; le verrou du changement de défaut ignore les wishlists retirées, les lignes remboursées et les lots clos ou annulés ; la demande potentielle ne compte que les wishlists des lots au sondage ; un kit peut être monté à tout statut de lot, sans plafond par rapport à la demande.
- Hugo autorise la modification de `SameSite` (`Lax`) dans auth-service à la reprise du travail. Le faire en montrant d'abord le fichier et la ligne.

### Clôture et cookie (2026-10-06)
- Clôture d'un lot : les machines invendues restent en stock et seront vendues hors du flux grossiste. Seule la livraison des machines vendues est exigée (comportement actuel, à conserver).
- Pas de domaines croisés : seulement des sous-domaines d'un même domaine. Le cookie d'auth peut donc passer en `SameSite=Lax` (changement à faire dans auth-service, hors de ce dépôt).

### Machines défectueuses et surplus
- Seules des machines contrôlées et fonctionnelles peuvent être attribuées à un utilisateur.
- S'il y a plus de commandes payées que de machines fonctionnelles, les dernières commandes en trop sont remboursées (ordre : paiement le plus récent d'abord).

### Workflow
- Le passage à « Commande en cours » est manuel, décidé par l'admin.
- Admin et technicien sont la même personne : un seul rôle (whitelist), pas de garde par rôle sur les transitions.
- Machine morte : retirée du stock, jamais vendue. Si elle était attribuée, elle est remplacée ; sinon l'utilisateur est remboursé. Une hashboard défectueuse est marquée telle quelle ; le technicien décide ensuite (annulation, remplacement, rabais).
- Expédition partielle possible : on peut expédier la partie d'un lot qui n'a pas besoin de montage sans attendre le reste.
- Pièces d'options : commandées en une fois, une fois les précommandes terminées, pour la quantité demandée.
- Un statut terminal après `in_transit` est accepté.
- Une option retirée pour un lot ne peut pas être la valeur par défaut du modèle.

## Jalon 0 : fondations
- [x] Revue logistique : `docs/reviews/logistique-2026-10-06.md`
- [x] Schéma v1, migration `init`, seed
- [x] Schéma v2 puis v3 (commande, paiement, lignes, statuts machine, `closed`, réservation 30 min, `auth_user_id` en BigInt)
- [x] Docker Compose (Postgres), scripts npm `db:*`, `.env.example`
- [x] Outillage de tests (unitaires + intégration sur Postgres réel)
- [x] Client Prisma, intégration auth, whitelist backoffice, healthcheck

## Jalons 1 et 2 : catalogue et lots
- [x] API catalogue + lots + machine à états (backend), contrat dans `docs/api.md`
- [x] UI backoffice (frontend)
- Jalon 2 clos le 2026-10-07 : schéma v4, backend, UI, `SameSite=Lax`, recette (`docs/reviews/logisticien-2026-10-07.md`) et revue qualité (`docs/reviews/qualite-2026-10-07.md`). Vérifications au dernier passage : tsc, lint, vitest 314/314, Playwright 19/19.

### Décisions du jalon 3 (Hugo, 2026-10-07)
- Plafond de wishlists par utilisateur et par lot : 5 par défaut (`WISHLIST_MAX_PER_USER_PER_BATCH`, 1 à 1000, plafonné par la quantité du lot).
- Le nom du lot est exposé au public s'il est renseigné ; le nom par défaut est « {quantité} {modèle} ».
- La configuration d'une wishlist est immuable dès que le lot passe en Précommande (modifiable seulement pendant le Sondage). Le retrait reste possible.
- On peut souhaiter une option au-delà de son `maxQty` (on mesure la demande).
- Lot dépublié (Sondage → Brouillon) : les wishlists restent visibles de l'utilisateur, pour qu'il ne croie pas l'avoir perdue.
- Principe : l'UI n'empêche jamais une action, les règles sont imposées par l'API (l'UI affiche les drapeaux et les erreurs du serveur). Retour après connexion : chemin complet d'origine (chemin relatif du site uniquement).
- Retirer une wishlist déjà convertie en commande payée est refusé par l'API (`409 wishlist_converted`) : on passe par l'annulation de la commande (jalon 4).
- **Invariant : on ne supprime jamais une facture** (dans le doute, jamais). Elle trace l'adresse de paiement : si on la supprimait avec ce à quoi elle est liée, l'utilisateur pourrait payer une adresse qui n'est plus supervisée, et le remboursement deviendrait difficile. Une facture (et son adresse) survit à la suppression ou au retrait de tout ce qui y est lié (wishlist retirée, lot, etc.) ; si besoin, on rembourse. Ce qui est en base aujourd'hui : toutes les clés étrangères de `Order`/`OrderLine` sont en `Restrict`, `payment_address` est unique ; à conserver au jalon 4 (pas de `DELETE`, pas de cascade sur les factures, adresses de paiement jamais réutilisées).
- Une ligne payée liée à une wishlist retirée est donc acceptable : l'invariant est de tracer et pouvoir rembourser, pas d'interdire.
- Prix dans « Mes intérêts » : la configuration reste un instantané ; l'UI affiche aussi le prix actuel du lot avec un avertissement quand il diffère.
- Pas de `loading.tsx` dans la boutique ni le backoffice (il fait répondre 200 aux pages introuvables). Le 403 du backoffice repose sur `forbidden()` (`experimental.authInterrupts`, accepté) ; repli possible par un 403 posé dans le proxy si l'API expérimentale change.
- Accueil : pas de pagination ni de filtre pour l'instant (peu de lots en sondage) ; la liste publique de l'API n'est pas plafonnée (à traiter avec le volume).
- Une facture en attente liée à une wishlist qui est ensuite retirée garde son statut (elle réserve déjà du stock 30 min) ; seule une nouvelle facture perd la priorité.
- Retirer une wishlist après l'ouverture des précommandes fait perdre la priorité (à appliquer au jalon 4).
- Lacunes de schéma mineures à voir avec `db-designer` : plafond de wishlists imposé seulement par le code ; pas de trigger sur la modification d'une configuration de wishlist (à fermer avec l'immuabilité dès la Précommande) ; pas de date de dernière modification sur `Configuration`.

### Décisions de clôture du jalon 2 (Hugo, 2026-10-07)
- Noms uniques sans casse ni espaces de bord (modèle, menu par modèle, valeur par menu, produit) ; les accents et espaces internes ne comptent pas. Index en base ; un `migrate deploy` en production échoue s'il existe des doublons (les renommer, puis `prisma migrate resolve --rolled-back 20261007140000_catalog_unique_names`).
- Un menu visible (choix ou Avec/Sans) qui propose moins de deux valeurs sur le lot bloque la publication et le PATCH d'un lot publié ; « Avec » à 0 € reste permis ; un menu masqué est hors règle.
- Alerte de marge non bloquante : revente × quantité < prix d'achat.
- Libellé d'une valeur modifiable après publication (inchangé).
- `from` obligatoire dans une transition de lot ; rejouer une livraison avec une autre quantité → `409 part_order_already_delivered` (rejeu identique : 200 sans effet).
- Les sondes e2e de la recette ont été supprimées.

### Décisions du jalon 4 (Hugo, 2026-10-07)
- Garde-fou anti-accaparement (valeurs par défaut, configurables) : une seule facture en attente vivante par utilisateur et par lot, 10 machines au plus par facture, 5 minutes entre deux factures expirées d'un même utilisateur.
- Appoint : l'expiration de 30 min court depuis la création de la facture (pas depuis chaque complément) ; un appoint est accepté tant qu'il reste de la place.
- Service de paiement Bitcoin simulé : un point d'entrée interne enregistre un paiement reçu sur une adresse de facture ; le vrai service l'appellera plus tard. Aucune adresse réutilisée, aucune facture supprimée.
- Notifications : dans l'app pour l'instant, e-mail branché plus tard.
- Priorité d'un jour : elle ne vaut que pour le nombre de machines wishlistées de l'utilisateur ; un lot sans wishlist active n'a pas de priorité.
- Délai de 5 min entre deux factures expirées : par utilisateur et par lot.
- Facture expirée partiellement payée : pas de remboursement automatique. L'utilisateur choisit entre l'appoint et le remboursement de ce qu'il a avancé, avec les frais réseau à sa charge dans ce cas (exception à « frais à la charge de la boutique »).
- Statut d'annulation d'une facture en attente impayée (libère la réservation sans attendre l'expiration).
- Prorata de remboursement arrondi au sat le plus proche sur le cumul.
- Paiement reçu après un remboursement intégral ou sur un lot abandonné : pas de remboursement automatique dans le doute, décision de l'admin, état « à traiter » dans le backoffice.
- Réglages (`ShopSettings`) : pas d'écran pour l'instant ; seuls les réglages par lot ou souvent modifiés doivent être accessibles facilement, le reste relève de la config de déploiement.
- Statut maximal acceptant des commandes : par défaut jusqu'à Packaging inclus (En transit refusé : machines remises au transporteur), à confirmer par Hugo. Les machines invendues se vendent hors flux grossiste.

- Renoncer à une commande payée : l'utilisateur peut le faire lui-même jusqu'au statut Précommande inclus, avec remboursement (même moyen, tout ce qui a été payé) ; après, seul l'admin.
- Adresse de remboursement : demandée à la création de la facture (facultative), mémorisée sur la facture ; sans adresse, le remboursement apparaît « à traiter » et l'admin contacte la personne.
- Utilisateur qui ne répond jamais sur une facture expirée partiellement payée : l'admin peut rembourser après contact, avec les frais réseau à la charge de l'utilisateur (il reçoit ce qu'il a envoyé moins les frais).
- Commandes acceptées jusqu'à Packaging inclus (confirmé). Service de paiement simulé : 1 BTC = 90 000 €, 2 000 sats de frais par remboursement, configurables (`PAYMENT_BTC_PRICE_EUR_CENTS`, `PAYMENT_REFUND_NETWORK_FEE_SATS`) ; `SimulatedPaymentService` à remplacer par le vrai service.

## Jalon 3 : sondage, boutique publique, wishlist
- [x] Backend : lecture publique des lots en Sondage, wishlists (`src/server/shop.ts`, `wishlists.ts`), mesure d'intérêt, contrat dans `docs/api.md`
- [x] UI boutique : accueil, fiche lot, « Mes intérêts », retour après connexion (`src/proxy.ts`)
- [x] Recette client (`docs/reviews/client-2026-10-07.md`) et revue qualité (`docs/reviews/qualite-2026-10-07-jalon3.md`)
- Clos le 2026-10-07. Dernières vérifications : tsc, lint, vitest 401/401, Playwright 32/32.
- Reste pour le jalon 4 : lot en Précommande visible côté boutique (`PUBLIC_STATUSES` à élargir), perte de priorité annoncée dans le dialogue de retrait, ordre des contrôles quantité/plafond (une quantité ≥ 101 affiche « 100 » alors que le plafond est 5), `lockedReason` à unifier avec les messages serveur, `writeConfiguration` à employer ou supprimer, date de modification de `Configuration`, scénario `db-down` boutique.

### Décisions de Hugo sur les remboursements (jalon 4, 2026-10-07/08)
- **Frais réseau** : la boutique ne les paie que lorsqu'elle initie l'annulation d'une commande payée (stock, machine défectueuse, lot abandonné, autre annulation par l'admin), plus le paiement tardif sans place et le rabais. Ils sont à la charge de l'utilisateur pour le renoncement, l'excédent de paiement et le paiement partiel sans réponse (il reçoit ce qu'il a envoyé moins les frais). Règle unique : fonction SQL `refund_cause_fee_payer(cause)`, facile à inverser. Remplace « frais à la charge de la boutique » des décisions précédentes.
- **Aucune décision automatique en cas ambigu** : excédent inférieur ou égal aux frais, paiement partiel inférieur aux frais (on attend l'appoint), paiement reçu après un remboursement intégral ou sur un lot abandonné : la facture reste « à traiter », l'admin décide et contacte la personne. Aucun délai automatique, pas de délai minimal avant un remboursement admin aux frais de l'utilisateur.
- L'admin choisit le motif d'un remboursement parmi ceux valides pour le cas (`planAdminRefund`, validés) ; il peut enregistrer un renoncement (`user_renounce`) à toute étape via `cancel-lines` (v5g). Pas de « conserver un excédent sans rembourser » pour l'instant.
- L'utilisateur peut renoncer à une commande payée jusqu'en Précommande incluse (frais à sa charge) ; ne compte pas comme un abandon pour l'anti-squatting ; pas de plafond sur les renoncements répétés.
- Adresse de remboursement : facultative à la création de la facture, modifiable tant qu'aucun remboursement n'est envoyé, journal d'audit append-only (trigger), pas de confirmation par e-mail, pas de mémorisation sur l'utilisateur, pas de route « envoyer ailleurs » (l'admin change l'adresse de la facture).
- Anti-squatting : délai 5 min par utilisateur et par lot après toute facture abandonnée (annulée ou expirée sans paiement complet, remboursement d'un paiement partiel compris), blocage au 3e abandon en 24 h jusqu'à levée par l'admin (`OrderBlockRelease`) ; valeurs dans `ShopSettings`.
- Commandes acceptées jusqu'à Packaging inclus (En transit refusé, fonction `batch_accepts_orders`).

### Décisions de Hugo à la clôture du jalon 4 (2026-10-09)
- **Lot annulé avec factures impayées** : les factures en attente sans aucun versement passent automatiquement à `cancelled` (réservation libérée, le client voit « Lot annulé »). Elles ne sont **jamais supprimées** (on doit savoir qui a payé et pourquoi, pour rembourser). Un versement reçu ensuite reste « à traiter », sans remboursement ni acceptation automatiques. Implémenté par la migration `20261009090000_v5h_lot_cancel_unpaid_orders` ; `changeBatchStatus` verrouille d'abord les factures en attente quand `to = cancelled` (évite un interblocage avec un paiement concurrent). Une transition écrite en SQL direct (fixtures, seed) contourne ce verrou ; le seul chemin de production est `changeBatchStatus`.
- **Excédent de paiement** : plus aucun remboursement automatique, aucun seuil de poussière. Tout excédent reste « à traiter » et l'admin décide. La base impose que le motif `overpayment` soit réservé à l'initiateur admin (contrainte `NOT VALID`). Seul remboursement automatique restant : `late_payment_no_room`. Conséquence : chaque excédent, même de 1 sat, devient une ligne de « À traiter » (charge de travail de l'admin en hausse).

## Jalon 4 : précommande, facture, paiement Bitcoin simulé, remboursements
- [x] Schéma v5 à v5h, backend, UI boutique et backoffice
- [x] Recette client (`docs/reviews/client-2026-10-08-jalon4.md`), recette backoffice (`docs/reviews/logisticien-2026-10-08-jalon4.md`), revue qualité (`docs/reviews/qualite-2026-10-09-jalon4.md`)
- Clos le 2026-10-09. Dernières vérifications (relancées par l'orchestrateur) : tsc et lint sans erreur ni avertissement, vitest 708/708 (39 fichiers), Playwright 49/49 en `--workers=1`. Couverture `src/server` : 96,3 % des instructions.
- Les scénarios d'exploration des testeurs (`e2e/customer/`, `e2e/logistician/`) sont conservés mais exclus de `npm run e2e`, de `tsc` et d'ESLint. Défauts connus : attentes en temps réel de 30 à 50 min (`expiry.spec.ts`, `expiry2.spec.ts`, `squat.spec.ts`), `expiry2.spec.ts` en doublon de `expiry.spec.ts`, `serve.sh` avec chemin absolu et secrets en dur, aucune assertion.
- Les questions ouvertes à la clôture (e-mail du client, classement sans suite, lot qui ferme les commandes, option retirée d'une wishlist figée) sont traitées par le lot v5i/v5j/v5k, voir « Décisions de Hugo sur les questions ouvertes du jalon 4 ».

## Jalon 5 : réception des machines, contrôle, attribution
- [x] Schéma v6 (`20261013120000_v6_machine_reception_inspection`, db-designer, 2026-10-13) : machines générées par la base à l'entrée en Attente de réception (une par place, quantité figée ensuite) ; statuts machine seulement par le journal append-only `MachineStatusChange` (qui, quand, motif ; table des transitions M1 à M15 de la revue logistique, `machine_transition_allowed`) ; contrôle sur machine reçue en main, lot au Contrôle ou après, cohérence avec les hashboards (`ok` = toutes ok ; hashboard morte = `degraded` ou `faulty`), auteur et date de chaque hashboard ; machine `faulty` retirée du stock dès qu'elle est marquée, mise au rebut seulement si `faulty`, terminal ; attribution d'une machine reçue, contrôlée, `ok` (ou `degraded` avec motif), lot du Contrôle à En transit, remplacement et retrait avec motif ; `batch_surplus_lines` (commandes payées en trop, la plus récente d'abord) ; vue `batch_machine_summary`. Contrat prévu dans `docs/api.md` (« Machines : réception, contrôle, attribution »). Seed : lot F « 4 S19 » au Contrôle (Erin, Frank).
- [ ] Backend (routes machines, attribution, remplacement, `BatchFacts` sur la vue), puis UI backoffice (réception, contrôle, attribution).
- Choix de conception (db-designer, sans règle métier nouvelle) : la base garantit « jamais plus de commandes payées et réservées que de machines utilisables » (`Batch_stock`) ; marquer morte une machine sur un lot plein exige de rembourser la ligne en trop dans la même transaction. L'ordre (paiement le plus récent d'abord) vient de `batch_surplus_lines`, que le domaine doit utiliser. Ordre des verrous : factures → lignes → machines → lot.

### Questions ouvertes du jalon 5 (pour Hugo)
1. Commande en trop : rembourser la **ligne** (une machine) la plus récente, ou **toute la commande** la plus récente ? Recommandation : la ligne (dernière machine de la facture payée la plus récente), au prorata, frais boutique.
2. Machine à hashboard défectueuse (`degraded`) : attribuable sur décision du technicien (motif tracé, rabais par le remboursement `discount` existant) sans accord préalable du client ? Recommandation : oui, motif obligatoire (en base), client prévenu par la boutique.
3. Une machine `degraded` compte-t-elle comme « fonctionnelle » pour le calcul des commandes en trop ? Recommandation : oui (comportement v6).
4. Machine morte alors que des factures **en attente** occupent les dernières places : la base refuse. Attendre l'expiration (30 min) ou annulation de ces factures par l'admin (cause `admin`, prête en base) ? Recommandation : route admin d'annulation d'une facture en attente sans versement.
5. Numéro de série obligatoire ? Recommandation : obligatoire pour attribuer une machine (identifie la machine expédiée) ; à poser en base (v6b) si validé.
6. Motif du remboursement : morte → `shop_defective_machine` ; jamais reçue (`missing`) → `shop_stock` ; perdue en transit (jalon 7) → `shop_stock`. À confirmer.
7. Ordre d'attribution : premier payé, premier servi (suggestion automatique, l'admin peut changer) ? Recommandation : oui, sans règle en base.
8. Conditions de sortie du Contrôle : bloquer Tuning / Packaging tant qu'il reste des machines attendues (à marquer reçues ou manquantes), des lignes à remplacer ou des commandes en trop ; bloquer Packaging tant qu'une ligne payée n'a pas de machine ? Recommandation : oui pour les quatre.
9. Mise au rebut définitive (aucun retour, même erreur de saisie) ? Recommandation : oui.
10. Machine livrée en plus de la quantité du lot : refusée par la base (quantité figée) ; à vendre hors flux grossiste ? Recommandation : oui.
11. Vue client : afficher « machine attribuée » (sans numéro de série) sur la ligne de la facture dès le jalon 5 ? Recommandation : oui, le suivi détaillé au jalon 7.

## Reprise (à lire en premier dans une nouvelle session)
**Contexte** : projet « boutique de mineurs » (voir `rules.md`, `specs.md`, ce fichier, `docs/api.md` pour le contrat d'API, `schema.dbml` pour les données). Le code est versionné (jalons 0 à 4 et lot v5i/v5j/v5k commités ; le rapport de ce lot est local). Les agents sont dans `.claude/agents/` (`db-designer`, `backend-dev`, `frontend-dev`, `quality-dev`, `logistics-agent`, `customer-tester`, `logistician-tester`) ; **un seul agent à la fois** sur la base de test, le port 3100 et `next dev` (verrou par dossier). Principes à garder : l'UI n'empêche jamais, l'API décide (mémoire `ui_never_blocks_backend_enforces`) ; on ne supprime jamais une facture ni son adresse de paiement ; pas de `loading.tsx` ; un agent ne modifie pas une migration déjà appliquée (créer la suivante) ; les services voisins (auth-service) ne se modifient qu'avec l'accord explicite de Hugo.

**État au 2026-10-13 : jalons 0 à 4 clos, lots v5i à v5l livrés (schéma, backend, UI) et décisions de Hugo du 2026-10-09 et du 2026-10-13 implémentées. Jalon 5 en cours : schéma v6 livré (db-designer, non commité), prochain travail = questions de Hugo (section « Jalon 5 ») puis backend-dev, puis frontend-dev** (réception des machines, contrôle, attribution). Dernières vérifications : tsc et lint propres, vitest 789/789, Playwright 62/62 en `--workers=1`. Les puces ci-dessous décrivent le jalon 4 tel que livré le 2026-10-08.

**État au 2026-10-08** :
- Jalons 0 à 3 clos. Jalon 4 (précommande, facture, paiement Bitcoin simulé, remboursements) : **schéma v5 à v5g livré** (rapport `docs/reviews/db-designer-jalon4-2026-10-07.md`, sections v5 à v5g), **backend livré** (`src/server/orders.ts`, `payments.ts`, `payment-service.ts`, `order-rules.ts`, `backoffice-orders.ts`, routes `src/app/api/orders`, `api/backoffice/orders|refunds|order-blocks|order-block-releases`, `api/internal/payments`).
- **UI du jalon 4 livrée par `frontend-dev`** (rapport résumé ci-dessous). Vérifié par l'orchestrateur après sa fin : `npx tsc --noEmit` et `npm run lint` sans erreur, `npx vitest run` 674/674 (37 fichiers), aucun `loading.tsx` sous `src/app`, Docker en marche ; Playwright 42/42 en `--workers=1` annoncé par l'agent (32 existants + 10 nouveaux : `e2e/orders.spec.ts` 8, `e2e/backoffice-orders.spec.ts` 2), **non relancé par l'orchestrateur**. Les erreurs `database "shop_e2e" is not currently accepting connections` dans le journal Playwright viennent du scénario volontaire `@db-down`.
- **Boutique** : accueil (« Commandes ouvertes » et « En sondage »), fiche lot avec « Commander », `lots/[batchId]/commander` (`OrderForm`), `mes-commandes` (liste) et `mes-commandes/[orderId]` (facture : adresse BTC, montants BTC/sats/euros, compte à rebours, relecture toutes les 15 s, appoint, choix appoint/remboursement, annulation, renoncement, adresse de remboursement), « Mes intérêts » avec « Commander » et perte de priorité annoncée au retrait.
- **Backoffice** : `/backoffice/a-traiter` (Ag Grid), `/backoffice/factures/[orderId]` (accepter, rembourser avec choix du motif et payeur des frais affiché, annuler des machines par ligne, adresse de remboursement et son historique), `/backoffice/remboursements` (envoi, gestion de `refund_destination_changed`), `/backoffice/blocages` (« Lever le blocage »), colonnes « À traiter » et « Priorité jusqu'au » dans la liste des lots, « Factures du lot » dans la fiche lot.
- Migrations v5 à v5g appliquées sur la base de dev (`migrate status` à jour). Pour repartir propre : `npm run db:reset`.

**Avant de travailler** : Docker Desktop doit tourner (`open -a Docker`, puis `npm run db:up`) ; sinon les tests échouent sans bug applicatif (c'est arrivé deux fois). Playwright : lancer `--workers=1` (en parallèle, 1 à 4 scénarios dépassent le délai, sans lien avec le code).

**Restes UI/API du jalon 4 signalés par `frontend-dev`** (état au 2026-10-09 : `SIGNED_IN_AREA`, `acceptsOrders` et le commentaire de `ConfirmDialog` sont traités, avec un test qui interdit un dialogue dans un `<form>` ; `writeConfiguration` n'est pas du code mort, `createOrder` l'emploie ; restent l'estimation du net avant renoncement, le QR code, le compteur « À traiter » et les points UX ci-dessous) :
- `src/proxy.ts` : ajouter `/mes-commandes` et `/lots/*/commander` à `SIGNED_IN_AREA` (aujourd'hui la page redirige elle-même vers la connexion, en 307, sans `loading.tsx` ; l'aligner sur « Mes intérêts »).
- Renoncement : l'API ne donne pas d'estimation du montant net avant l'envoi (`GET` ou `dryRun` à ajouter) ; l'UI annonce seulement que les frais sont déduits.
- `Wishlist.batch` n'expose pas `acceptsOrders` : « Commander » dans « Mes intérêts » se base sur `isPublic && status !== "survey"` ; exposer le drapeau.
- **Bug latent à vérifier** : `ConfirmDialog` contient un `<form>` ; rendu dans un autre `<form>`, le parseur HTML du rendu serveur supprime la balise imbriquée et la confirmation soumet le formulaire extérieur en GET. Corrigé dans les nouveaux composants (dialogue sorti du formulaire) ; vérifier les écrans existants et corriger le commentaire de `ConfirmDialog`.
- Points UX à arbitrer par Hugo : (1) les actions proposées suivent les drapeaux de l'API ; seule la modification de l'adresse de remboursement reste toujours proposée, le serveur la refuse quand elle est figée : lecture du principe « l'UI n'empêche jamais » à confirmer ; (2) envoi d'un remboursement : l'adresse est préremplie, faut-il obliger l'admin à la coller lui-même depuis son portefeuille (contrôle croisé) ? (3) le dialogue d'annulation annonce un délai et une suspension sans chiffres (réglages configurables) ; (4) pas de QR code (bibliothèque à ajouter) ; (5) navigation du backoffice à 6 entrées sans compteur « À traiter (3) » (lecture à ajouter dans le layout).

**Ensuite (un agent à la fois)** : le jalon 4 est clos (recettes et revue qualité faites). Prochaine étape : jalon 5 (réception des machines, contrôle, attribution) et 6 (tuning, packaging, expédition, clôture) : aucun écran ni API n'existent encore pour le flux machine.

**Simuler un paiement en dev** : voir la commande `curl` de `docs/api.md` (`POST /api/internal/payments` avec `Authorization: Bearer $PAYMENT_WEBHOOK_SECRET` et `{ address, txid, vout, amountSats }`).

**Variables d'environnement à connaître** (`.env.example`) : `PUBLIC_URL` (obligatoire en production), `BACKOFFICE_USER_IDS` (whitelist ; vide = personne), `JWT_SECRET`, `PAYMENT_WEBHOOK_SECRET` (sans valeur, la route interne répond 404), `PAYMENT_BTC_PRICE_EUR_CENTS` (défaut 90 000 €), `PAYMENT_REFUND_NETWORK_FEE_SATS` (défaut 2 000). Réglages de boutique en base : table `ShopSettings` (plafond de wishlists 5, machines par facture 10, délai 5 min, blocage 3 abandons en 24 h).

**À faire par Hugo hors dépôt** : déployer le `SameSite=Lax` d'auth-service (modifié dans `auth-service back/src/v1/cookie.py`, non commité) ; définir `PUBLIC_URL` au déploiement ; remplacer `SimulatedPaymentService` par le vrai service de paiement Bitcoin ; en production, la migration `20261007140000_catalog_unique_names` échoue s'il existe des doublons (les renommer puis `prisma migrate resolve --rolled-back …`).

**Restes connus à traiter plus tard** : `lockedReason` (UI) répète les messages serveur ; pas de scénario `db-down` pour la boutique ; pagination/filtre de l'accueil et plafond de la liste publique ; prix de `Mes intérêts` (instantané + avertissement, fait) ; `shop_stock` accepte l'initiateur `system` mais rien ne le crée ; `refundAttentionOrder` choisit `admin_other` même pour un lot abandonné (même payeur de frais) ; les `created_at` d'`Address`/`User`/`Machine`/`Batch`/`Model` restent posés par le client (sans effet sur les délais) ; l'identifiant admin du journal d'adresses n'est pas vérifié contre la whitelist ; pas de vérification de somme de contrôle des adresses Bitcoin en base ; `forbidden()` repose sur `experimental.authInterrupts` (repli possible par un 403 posé dans le proxy) ; reliquat du formulaire de lot si un autre admin modifie le lot pendant la saisie (flux `409 batch_modified`).

**Idées en réserve** : message `menu_without_choice` à adapter pour un Avec/Sans ; `blockers` avec l'id du menu ; avertissement en direct quand on décoche « Avec » ; lien vers la correction d'inventaire sur une livraison rejouée ; `note` différente ignorée lors d'un rejeu identique de livraison ; référence ou lien d'achat sur un produit d'option (question à Hugo, sans réponse) ; section « Écarts connus » de `rules.md` obsolète à retirer.

### Décisions de Hugo sur les questions ouvertes du jalon 4 (2026-10-09 ; livrées en v5i/v5j/v5k)
- **E-mail du client** : auth-service n'a pas d'adresse e-mail en base. L'e-mail vit dans la base de ce projet, car seul ce projet le consomme ; l'admin le voit pour contacter la personne. Reste à concevoir (db-designer) : où et quand il est recueilli (à la création de la facture ou de la wishlist ?), vérification éventuelle, vie privée.
- **Excédent inférieur ou égal aux frais** : action « classer sans suite » avec journal d'audit.
- **Reliquat d'excédent d'un renoncement complet** : l'admin choisit (décision de l'admin, pas un départ automatique avec l'annulation).
- **Lot qui ferme les commandes sans être annulé** (En transit, etc.) : ses factures impayées sont aussi annulées automatiquement, jamais supprimées (même règle que le lot annulé).
- **Option retirée d'un lot pour une wishlist figée** : l'utilisateur ne retire pas la machine ; l'option est seulement retirée de sa wishlist et il en est prévenu. La priorité est conservée.
- [x] Schéma v5i (`20261009120000_v5i_contact_email_dismissal_withdrawal`, 2026-10-09) : `Order.contact_email` (figé, format en base), `OrderExcessDismissal` (classer sans suite), `Order_refunded_in_full` assoupli (reliquat laissé à l'admin), annulation des factures impayées à toute fermeture des commandes, `WishlistOptionWithdrawal` (option retirée d'une wishlist figée). Contrat dans `docs/api.md`.
- Réponses de Hugo aux questions de la v5i (2026-10-09) : (1) l'e-mail est une donnée du profil (`User.email`, modifiable par l'utilisateur dans une vue profil), l'instantané reste figé sur la facture, l'admin voit les deux s'ils diffèrent, pas de correction admin ; (2) versement après un classement sans suite : rien d'automatique, l'admin décide ; (3) annulation de toute une commande payée par la boutique : l'excédent reste « à traiter », comme pour le renoncement ; (4) option retirée : ajustement immédiat avec avertissement, sondage compris ; pas d'avertissement pour les wishlists retirées ou converties.
- [x] Schéma v5j (`20261009150000_v5j_user_email_withdrawal_survey`, db-designer, 2026-10-09) : `User.email` (format en base, reprise depuis les factures, vue `user_contact_email` supprimée), instantané de la facture copié du profil s'il n'est pas fourni, ajustement immédiat des wishlists à tout statut vivant, journal limité aux wishlists non retirées et non converties, calcul du non-affecté d'un classement corrigé.
- [x] Backend v5i/v5j et migration v5k (`20261009180000_v5k_contact_email_required_renounce_remainder`, backend-dev, 2026-10-09) : profil `GET`/`PATCH /api/profile` (e-mail modifiable, jamais vidé) ; `contactEmail` à la création de facture (facultatif si le profil en a un, mémorisé sur le profil s'il en diffère, `profileEmail` dans l'éligibilité) ; `contactEmail` et `profileEmail` au backoffice (facture, « À traiter », « Blocages ») ; « Classer sans suite » (`POST /api/backoffice/orders/{orderId}/dismiss-excess`, `attention.canDismiss`, `dismissal`) ; plus aucun reliquat d'excédent écrit avec une annulation complète, quelle qu'en soit la cause ; factures en attente verrouillées avant le lot pour toute transition qui ferme les commandes, `cancelsPendingOrders` dans la confirmation ; `optionWithdrawals` sur la wishlist, `409 withdrawn_value_has_choices` avant de retirer une valeur choisie. v5k : `Order_contact_email_required` activé, reliquat interdit dans un renoncement fait par l'utilisateur. Contrat dans `docs/api.md`.
- [x] UI v5i/v5j/v5k (`frontend-dev`, 2026-10-09) : vue « Mon profil » (`/profil`, lien dans l'en-tête de la boutique, gardée par le proxy) ; champ e-mail obligatoire du formulaire de commande, prérempli par `profileEmail`, avec l'annonce du remplacement de l'e-mail du profil ; e-mail de contact, classement sans suite, excédent resté après un renoncement complet et facture annulée par un lot fermé aux commandes sur la facture du client ; renoncement qui annonce que l'excédent n'est pas renvoyé d'office ; avertissement `optionWithdrawals` dans « Mes intérêts » et sur la fiche d'une manifestation d'intérêt ; backoffice : « Classer sans suite » (motif facultatif, refus 409 affichés avec leurs montants) et sa trace, e-mails `mailto:` (fiche facture, colonne « Client » de « À traiter » et « Blocages »), factures annulées annoncées dans la confirmation de transition (`cancelsPendingOrders`), confirmation de `409 withdrawn_value_has_choices` dans le formulaire de lot. E2E : `e2e/contact-email.spec.ts`, `e2e/excess-and-closures.spec.ts`, assertions ajoutées à `orders-edge-cases` et `backoffice-orders`.
- [x] Revue qualité du lot (2026-10-09) : corrigés l'erreur d'e-mail dite deux fois dans le formulaire de commande, l'annonce des factures annulées dite deux fois dans la confirmation de transition, le lien `mailto:` (e-mail du client encodé : la base n'impose qu'un format souple), le doublon de construction des erreurs nommées (`apiErrorOf`), `schema.dbml` (migration v5k, reliquat). Base de dev à jour (v5k appliquée). Le compte de `withdrawn_value_has_choices` est exact : la disponibilité ne se modifie qu'au brouillon et au sondage, où aucune wishlist n'est encore convertie.
- Vérifications du lot (relancées à la revue) : voir le rapport local `docs/reviews/qualite-2026-10-09-v5k.md`. Aucun scénario e2e pour une facture annulée par un passage à En transit ou Clôturé : il faut des machines expédiées (jalon 5).
- [x] Backend v5l (`20261013090000_v5l_cancel_reason_paid_after_refund`, backend-dev, 2026-10-13) : `cancelReason` (`user`, `batch_closed`, `admin` ; `null` si jamais annulée, conservée après acceptation ou remboursement) dans `Order`, `AdminOrder` et « À traiter » ; `payment.surplusLeftSats` et `payment.paidAfterRefundSats` lus dans `order_payment_balance` ; annulation par le client écrite avec `cancel_reason: "user"`. Contrat dans `docs/api.md`. 

### Décisions de Hugo sur les recommandations de la revue qualité v5k (2026-10-13)
- **Cause d'annulation** : `Order.cancel_reason` posée par la base (v5l) ; l'écran la lit et ne la déduit plus de l'état du lot (qui sert seulement à nommer son statut).
- **Surplus resté / versement arrivé après le remboursement** : montants calculés par la base (`surplusLeftSats`, `paidAfterRefundSats`), aucune comparaison de dates à l'écran ; les deux messages s'affichent s'ils sont tous deux non nuls.
- **Ordre « Rembourser » / « Classer sans suite »** : inversé dans le seul cas où l'excédent ne dépasse pas les frais réseau (« Classer sans suite » principal) ; aucun bouton masqué.
- **« Mon profil »** reste dans la zone compte de l'en-tête.
- **Grille « À traiter »** : pas d'élargissement ; colonnes de montants réduites, « Facture » et « Client » épinglées à gauche, pas de défilement horizontal à 1280 px.
- [x] UI v5l (`frontend-dev`, 2026-10-13) : facture du client selon `cancelReason` (« Facture annulée », « Lot annulé » ou « lot fermé aux commandes », « Facture annulée par la boutique » ; rappel de la cause sur une facture annulée puis payée ou remboursée), surplus resté et versement tardif lus dans `payment` ; backoffice : cause sur la fiche facture et sous le statut dans « À traiter », « Surplus resté » et « Versé après le remboursement » sur la fiche d'une facture remboursée, ordre des boutons, grille à colonnes épinglées. E2E : `e2e/cancel-reason.spec.ts`.

## Questions ouvertes
- 500 non reproduit sur `POST /api/backoffice/batches` à froid (piste : `connectionTimeoutMillis: 5000` de `src/server/db.ts` atteint pendant la compilation de `next dev`).
- Grille « À traiter » du backoffice : filtre, recherche, colonnes tronquées.
- Seuil d'alerte conseillé avant passage à « Commande en cours » (indicatif, la décision reste manuelle) ?
- Procédure en cas de colis perdu.
- Notifications aux utilisateurs : dans l'app pour l'instant, e-mail à brancher plus tard (décision de Hugo) ; la table de notifications / l'état lu-non lu n'est pas modélisé (les notifications se dérivent des journaux).
