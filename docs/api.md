# API (jalons 1 à 4 : catalogue, lots, stock des produits d'options, boutique publique, manifestations d'intérêt, factures et paiement)

Contrat pour le frontend. Code : `src/app/api/backoffice/**`, `src/app/api/shop/**`, `src/app/api/wishlists/**`, `src/app/api/orders/**`, `src/app/api/addresses`, `src/app/api/profile`, `src/app/api/internal/payments` (routes), `src/server/catalog.ts`, `src/server/batches.ts`, `src/server/batch-status.ts` (machine à états, domaine pur), `src/server/batch-settings.ts` (réglages d'options d'un lot, domaine pur), `src/server/part-stock.ts` (stock des produits d'options), `src/server/configurations.ts` (offre d'un lot et configuration complète d'une machine), `src/server/shop.ts` (boutique publique), `src/server/wishlists.ts` (manifestations d'intérêt), `src/server/order-rules.ts` (règles des factures, domaine pur), `src/server/orders.ts` (factures de l'utilisateur), `src/server/payments.ts` (paiements reçus et traitement automatique), `src/server/payment-service.ts` (service de paiement Bitcoin, **simulé**), `src/server/backoffice-orders.ts` (factures au backoffice), `src/server/manual-sales.ts` (clients et vente manuelle hors chaîne, refonte R5b), `src/server/shop-settings.ts` (réglages `ShopSettings`), `src/server/profile.ts` (e-mail du profil). Schéma : v6 (migrations `prisma/migrations/`). v6 (machines du jalon 5) : **implémenté par la refonte R3a** (réception, contrôle, statuts jusqu'à la livraison, attribution, machines en moins remboursées, stock par modèle), voir « Machines : réception, contrôle, attribution, expédition ». v5l exposée par l'API : `cancelReason` (`Order`, `AdminOrder`, « À traiter »), `payment.surplusLeftSats` et `payment.paidAfterRefundSats` (`Order`, `AdminOrder`). Refonte machines / stock, jalon R2b : **lot de stock** exposé (`kind`, création, transitions par type, réassorts, transferts palette → stock, boutique et commande sur le stock), voir « Lots » et « Lot de stock : réassort et transfert ».

Les conventions ci-dessous valent pour toutes les routes ; seul l'accès diffère : backoffice (whitelist), boutique publique (sans connexion), manifestations d'intérêt, profil, factures et adresses (utilisateur connecté), paiement interne (secret du service de paiement).

Devise unique : l'euro. Aucun champ `currency` (refusé en entrée : `400 invalid_input`).

## Conventions

- **Accès** : les routes `/api/backoffice/**` exigent le cookie `access_token` d'auth-service ET un `user_id` de la whitelist `BACKOFFICE_USER_IDS`. Sinon `401 unauthenticated` ou `403 forbidden`. `/api/shop/**` : public. `/api/wishlists/**`, `/api/orders/**`, `/api/addresses` : cookie `access_token` seul (`401 unauthenticated`). `/api/internal/**` : jamais appelé par le navigateur (secret du service, voir « Paiement : point d'entrée interne »).
- **Corps** : JSON, avec `Content-Type: application/json` obligatoire (paramètres comme `; charset=utf-8` admis), sinon `415 unsupported_media_type`. Les champs inconnus sont refusés (`400 invalid_input`) : une faute de frappe ne passe pas en silence.
- **Écritures même origine uniquement** : voir « Requêtes cross-site » ci-dessous (`403 cross_origin`).
- **BIGINT en chaînes** : montants en centimes, montants en satoshis (`…Sats`), hashrate en H/s, identifiants auth-service (`changedBy`, `authUserId`) sont des **chaînes décimales**, en entrée comme en sortie : `"3500"` = 35,00 €. Jamais de nombre JSON pour ces champs (`3500` est refusé). Raison : `number` perd des chiffres au-delà de 2^53 et `JSON.stringify` ne sait pas sérialiser un `bigint`. Côté UI : `BigInt(value)` pour calculer, ou formatage direct en divisant la chaîne.
- **Entiers simples** (quantités, positions, `maxQty`, `hashboardQtt`) : nombres JSON.
- **Dates** : chaînes ISO 8601 (UTC). `Batch.updatedAt` est à la microseconde (`"2026-10-06T10:00:00.123456Z"`, précision de la base) : à renvoyer tel quel dans `expectedUpdatedAt`, sans passer par `Date` (qui tronque à la milliseconde).
- **Textes facultatifs** : `""` ou `null` = absent. Les espaces de bord sont retirés.
- **Réponses** : non mises en cache (`Cache-Control: no-store`). Création `201`, suppression sans corps `204`.
- **Identifiants** : uuid. Un identifiant de chemin mal formé donne `404` (comme un inconnu).

### Erreurs

Toujours la même forme, `message` en français, affichable tel quel :

```json
{ "error": { "code": "batch_field_locked", "message": "Au statut « Précommande », ces champs ne sont plus modifiables : « Prix de revente »." } }
```

Entrée invalide (`400 invalid_input`) : `issues` liste les champs (`path` en notation pointée), sans recopier la saisie :

```json
{ "error": { "code": "invalid_input", "message": "Certaines données envoyées sont invalides.",
  "issues": [{ "path": "optionValues.0.priceOverride", "message": "Montant en centimes attendu, sous forme de chaîne (ex. \"3500\")" }] } }
```

Certaines erreurs portent des **`details`** structurés, pour afficher une date ou un nombre sans analyser le message (dates en ISO 8601, sats en chaînes) :

```json
{ "error": { "code": "order_cooldown", "message": "Vous venez d'abandonner une facture sur ce lot : vous pourrez en créer une nouvelle à 14:35.",
  "details": { "cooldownEndsAt": "2026-10-07T12:35:00.000Z" } } }
```

`429` (délai) porte aussi l'en-tête `Retry-After` (secondes).

Tous les messages sont en français, y compris ceux de la validation générique de Zod (« UUID invalide », « Entrée invalide : objet attendu, tableau reçu ») : la langue de Zod est réglée une fois pour toutes dans `src/server/errors.ts`. Les messages propres à un champ l'emportent.

Suppression ou modification refusée parce qu'un élément l'empêche : `blockers` nomme chaque élément (pour l'afficher et proposer un lien), `kind` ∈ `batch` (lot), `option_value` (valeur d'option), `part_order` (commande de produit d'un lot), `stock_movement` (historique de stock d'un produit) :

```json
{ "error": { "code": "model_in_use", "message": "Ce modèle est utilisé par 1 lot(s) : « Palette A (Brouillon) ». Il ne peut pas être supprimé.",
  "blockers": [{ "kind": "batch", "id": "uuid", "label": "Palette A (Brouillon)" }] } }
```

Codes communs : `400 invalid_json`, `400 invalid_input`, `401 unauthenticated`, `403 forbidden`, `403 cross_origin`, `409 retry` (conflit concurrent, réessayer), `415 unsupported_media_type`, `500 internal`. Une action sans paramètre (annuler, accepter) s'envoie avec le corps `{}` et `Content-Type: application/json`, comme toute écriture. Les codes propres à chaque route sont listés avec elle.

### Rafraîchissement de la session

Le jeton d'accès (cookie `access_token`) dure 15 minutes. `src/proxy.ts` (logique dans `src/server/session-refresh.ts`) le rafraîchit avant tout rendu : si le jeton est absent, expiré ou invalide et que le cookie `refresh_token` est présent, il appelle `POST {AUTH_API_URL}/refresh`, puis (1) transmet à la requête en cours les nouveaux cookies (pages, Server Components, routes API voient déjà la session) et (2) renvoie au navigateur les `Set-Cookie` d'auth-service tels quels. Valable sur toutes les routes, backoffice et API compris.

- Le jeton de rafraîchissement tourne à chaque usage : les requêtes simultanées avec le même jeton partagent un seul appel (sinon la seconde serait refusée).
- Refus d'auth-service (jeton expiré, révoqué) ou panne (délai 5 s) : aucune session ; l'espace personnel redirige vers la connexion (307), les autres routes répondent comme pour un visiteur (401 pour les routes protégées).

### Requêtes cross-site (CSRF)

Le cookie `access_token` d'auth-service est posé en `SameSite=Lax` sur le domaine parent : un site tiers ne peut plus le faire envoyer sur un POST, mais les autres sous-domaines (même site) le peuvent. Deux protections, valables pour **toutes** les routes, y compris celles ajoutées plus tard (rien à déclarer par route) :

1. **Contrôle d'origine** sur toute méthode autre que `GET`, `HEAD`, `OPTIONS` (`src/server/origin.ts`, appliqué par `src/proxy.ts` sur toutes les routes, et à nouveau par `withErrorHandling` dans chaque handler) :
   - `Sec-Fetch-Site` présent : seul `same-origin` passe (`same-site` est refusé : les autres services du domaine parent n'ont pas à écrire ici) ;
   - sinon `Origin` présent : son hôte doit être celui de la requête (`X-Forwarded-Host`, à défaut `Host`) ; `Origin: null` est refusé ;
   - ni l'un ni l'autre : accepté. C'est un client hors navigateur (curl, scripts, `request` de Playwright), qui n'a pas le cookie d'une victime ; tout navigateur pris en charge par Next 16 (Chrome/Edge/Firefox 111+, Safari 16.4+) envoie `Origin` et `Sec-Fetch-Site` sur une écriture cross-origin.
   - Refus : `403 cross_origin`, avant l'authentification et la lecture du corps.
   - Derrière un reverse proxy qui réécrit `Host`, il doit transmettre `X-Forwarded-Host` (comportement par défaut de Traefik).
2. **`Content-Type: application/json` exigé** (`415`) : un formulaire HTML ne peut pas l'envoyer, et un `fetch` cross-origin avec ce type déclenche un preflight CORS que l'application n'autorise jamais.

Le `fetch` same-origin de l'UI (`Content-Type: application/json`) n'a rien à changer.

### En-têtes de sécurité

Toutes les réponses (`next.config.ts`) : pas de `X-Powered-By` ; `X-Frame-Options: DENY` et `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` (anti-clickjacking) ; `X-Content-Type-Options: nosniff` ; `Referrer-Policy: strict-origin-when-cross-origin` ; `Permissions-Policy` fermant caméra, micro, géolocalisation, paiement, USB, topics. Pas de `script-src`/`style-src` : sans `'unsafe-inline'` il faudrait un nonce par requête (rendu dynamique de toutes les pages) et Ag Grid pose des styles en ligne ; avec `'unsafe-inline'` la directive n'apporterait presque rien. HSTS : au proxy TLS du Swarm.

### Bornes de saisie

Plafonds anti-faute de frappe (un vrai lot ne les atteint pas). Chaque champ hors bornes donne **une seule** entrée dans `issues`, dont le message cite la plage exacte :

| Champ | Bornes (incluses) | Message |
|---|---|---|
| `Batch.quantity` | 1 à 10 000 | « Nombre entier de machines compris entre 1 et 10 000 attendu » |
| `Batch.purchasePrice` (lot entier) | `"1"` à `"10000000000"` centimes (0,01 à 100 000 000,00) | « Montant compris entre 0,01 et 100 000 000,00 attendu » |
| `Batch.resaleUnitPrice` (par machine, s'il est fourni) | `"1"` à `"100000000"` centimes (0,01 à 1 000 000,00) ; `null` admis en brouillon | « Montant compris entre 0,01 et 1 000 000,00 attendu » |
| `Model.hashrate` | `"1"` à `"10000000000000000"` H/s (10 PH/s) | « Hashrate en H/s attendu, sous forme de chaîne, entre "1" et "10000000000000000" (10 000 TH/s) » |
| `Model.hashboardQtt` | 1 à 20 | « Nombre de hashboards compris entre 1 et 20 attendu » |

Les séparateurs de milliers des messages sont des espaces insécables fines (U+202F, format `fr-FR`). Un prix 0 est refusé (achat et revente) ; les prix d'option et les dérogations restent ≥ 0 (« Sans kit » à 0 €).

---

## Catalogue

### Objets

**Model** (détail)
```json
{
  "id": "uuid", "name": "S19", "hashrate": "95000000000000", "hashboardQtt": 3,
  "description": "Antminer S19 95 TH/s", "createdAt": "2026-10-06T10:00:00.000Z",
  "optionCount": 1, "batchCount": 0,
  "options": [Option]
}
```
La liste renvoie les mêmes champs sans `options`.

**Option** (menu)
```json
{
  "id": "uuid", "modelId": "uuid", "kind": "choice", "title": "Kit de ventilation",
  "description": "Choisissez…", "position": 0,
  "values": [
    { "id": "uuid", "optionId": "uuid", "label": "Sans kit", "isDefault": true, "price": "0", "position": 0, "parts": [] },
    { "id": "uuid", "optionId": "uuid", "label": "Silent kit", "isDefault": false, "price": "7500", "position": 2,
      "parts": [{ "id": "uuid", "name": "Ventilateur silencieux", "reference": "NF-A12", "qty": 4 }] }
  ]
}
```
`kind` : `choice` (choix entre options) ou `toggle` (Avec/Sans). Valeurs triées par `position` puis `label`, menus par `position` puis `title`.

**Part** : `{ "id": "uuid", "name": "Ventilateur silencieux", "reference": "NF-A12" | null }`

### Règles
- Un menu a **toujours exactement une valeur par défaut** dès qu'il a des valeurs (garanti en base).
- **Le défaut est gratuit** (0 €) : c'est la machine « brute ». Créer ou désigner un défaut payant, ou donner un prix au défaut : `422 default_value_not_free` (à la création d'un menu : `400 invalid_input` sur `values.N.price`). Pour faire d'une valeur payante le défaut : `{ "isDefault": true, "price": "0" }` dans la même requête.
- On ne retire jamais le défaut d'une valeur : on le donne à une autre (`isDefault: true`), l'ancienne cesse d'être le défaut dans la même transaction.
- `toggle` (Avec/Sans) : deux valeurs créées par le serveur, « Sans » (0, position 0, **toujours le défaut**) et « Avec » (`price`, position 1). On peut modifier leurs libellés, le prix d'« Avec » et ses pièces ; pas en ajouter ni en supprimer (`409 toggle_values_fixed`), ni faire d'« Avec » le défaut (`409 toggle_default_fixed`).
- Une valeur retirée d'un lot (`enabled: false`) ne peut pas devenir la valeur par défaut.
- **Prix catalogue figé** tant qu'un lot publié non terminé (Sondage à En transit) propose la valeur : `409 option_price_frozen`, `blockers` = les lots. Pour changer le prix sur un lot : dérogation de prix (`priceOverride`) sur ce lot. Le prix se débloque quand le lot est clôturé ou annulé.
- **Changement de défaut** refusé s'il modifierait une manifestation d'intérêt ou une commande vivante d'un lot non clos ni annulé (`409 default_change_locked`) : configuration sans choix dans ce menu (menu masqué, défaut implicite) ou ayant payé la valeur qui deviendrait le défaut.
- Une valeur ajoutée à un menu après la publication d'un lot n'est pas proposée sur ce lot : voir « Proposer sur ce lot ». Un menu ajouté après la publication ne s'applique pas au lot.
- Suppression refusée si l'élément est utilisé, avec `blockers` : modèle mis en lot (`batch`) ; menu réglé sur un lot (masqué, instantané de publication, réglage d'une valeur) ou choisi dans une configuration, défauts compris (`batch`) ; valeur réglée ou choisie (`batch`) ; produit associé à une valeur (`option_value`), commandé pour un lot (`part_order`) ou ayant un historique de stock (`stock_movement`).
- Le `kind` et le modèle d'un menu ne changent pas après création (`409 option_kind_fixed` en base).
- **Noms uniques**, sans tenir compte des majuscules ni des espaces de bord (`« s19 »` = `S19`) : nom de modèle (global), titre de menu (par modèle), libellé de valeur (par menu), nom de produit (global). Garanti en base (index uniques `lower(btrim(…))`, sûr en concurrence), à la création comme à la modification : `409 model_name_taken`, `409 option_title_taken`, `409 option_value_label_taken`, `409 part_name_taken`. Renommer en changeant seulement la casse de son propre nom reste permis. Deux valeurs de même libellé dans un même `POST …/options` : `409 option_value_label_taken`, rien n'est créé.
- **Menu « choix » à une seule valeur** : permis au catalogue (un menu se remplit valeur par valeur), mais un lot ne se publie pas tant qu'un menu visible propose moins de deux valeurs (voir « Machine à états » et `409 menu_without_choice`). La règle vaut aussi pour un menu Avec/Sans dont « Avec » est retiré du lot (seul « Sans » resterait proposé). « Avec » à 0 € est permis.

### `GET /api/backoffice/models`
→ `200 { "items": [ModelSummary] }` (trié par nom).

### `POST /api/backoffice/models`
```json
{ "name": "S19", "hashrate": "95000000000000", "hashboardQtt": 3, "description": "facultatif" }
```
`name` 1–120 car., unique ; `hashrate` 1 à 10^16 H/s (chaîne) ; `hashboardQtt` 1–20 (voir « Bornes de saisie »). → `201 Model`. `409 model_name_taken`.

### `GET /api/backoffice/models/{modelId}`
→ `200 Model` avec ses menus, valeurs et pièces. `404 model_not_found`.

### `PATCH /api/backoffice/models/{modelId}`
Mêmes champs que la création, tous facultatifs (`description: null` l'efface). → `200 Model`. `404 model_not_found`, `409 model_name_taken`.

### `DELETE /api/backoffice/models/{modelId}`
Supprime le modèle et ses menus. → `204`. `404 model_not_found`, `409 model_in_use` (au moins un lot).

### `POST /api/backoffice/models/{modelId}/options`
Crée un menu, avec ses valeurs dans la même transaction.

Choix entre options (les valeurs peuvent aussi être ajoutées ensuite) :
```json
{
  "kind": "choice", "title": "Kit de ventilation", "description": "facultatif", "position": 0,
  "values": [
    { "label": "Sans kit", "price": "0", "isDefault": true, "position": 0 },
    { "label": "Air Flow", "price": "3500", "position": 1 },
    { "label": "Silent kit", "price": "7500", "position": 2, "parts": [{ "partId": "uuid", "qty": 4 }] }
  ]
}
```
Sans `isDefault`, la première valeur devient le défaut. Deux `isDefault: true` → `400`. `position` absente : après le dernier menu (valeurs : leur rang dans la liste).

Avec/Sans :
```json
{ "kind": "toggle", "title": "Kit silencieux", "price": "7500", "defaultOn": false, "parts": [{ "partId": "uuid", "qty": 1 }] }
```
`price` et `parts` concernent la valeur « Avec ». « Sans » est toujours le défaut : `defaultOn` n'accepte que `false` (champ conservé pour compatibilité), `defaultOn: true` → `400 invalid_input` (`path: "defaultOn"`).

→ `201 Option`. `400 invalid_input` (défaut payant, plusieurs défauts), `404 model_not_found`, `409 option_title_taken`, `409 option_value_label_taken` (deux valeurs de même libellé), `422 unknown_part`.

### `PATCH /api/backoffice/options/{optionId}`
`{ "title"?, "description"?, "position"? }` → `200 Option`. `404 option_not_found`, `409 option_title_taken`.

### `DELETE /api/backoffice/options/{optionId}`
→ `204`. `404 option_not_found`, `409 option_in_use` (`blockers` : lots).

### `POST /api/backoffice/options/{optionId}/values`
Menu `choice` uniquement.
```json
{ "label": "Silent kit", "price": "7500", "isDefault": false, "position": 2, "parts": [{ "partId": "uuid", "qty": 1 }] }
```
La première valeur d'un menu vide devient le défaut ; `isDefault: true` remplace l'ancien défaut. Dans les deux cas `price` doit être `"0"`. `position` absente : après la dernière. La valeur n'est pas proposée par les lots déjà publiés (« Proposer sur ce lot »).
→ `201 Option` : le **menu complet**, pas la valeur créée (son `id` est celui du menu ; retrouver la nouvelle valeur par son libellé dans `values`). `404 option_not_found`, `409 toggle_values_fixed`, `409 option_value_label_taken`, `409 default_change_locked`, `422 default_value_not_free`, `422 unknown_part`.

### `PATCH /api/backoffice/option-values/{valueId}`
`{ "label"?, "price"?, "position"?, "isDefault"?: true, "parts"?: [{ "partId", "qty" }] }`. `parts` **remplace** la liste des pièces (`[]` les retire).
→ `200 Option`. `404 option_value_not_found`, `409 option_value_label_taken`, `409 default_value_required` (`isDefault: false` sur le défaut), `409 default_value_withdrawn`, `409 toggle_default_fixed`, `409 option_price_frozen` (`blockers` : lots), `409 default_change_locked`, `422 default_value_not_free`, `422 unknown_part`, `409 option_kit_required` (`parts: []` sur une valeur à kit qu'une ligne active d'une facture payée a choisie ; `details.lines` = nombre de lignes ; remplacer les produits reste permis ; en base : `OptionValuePart_kit_required`, au COMMIT).

### `DELETE /api/backoffice/option-values/{valueId}`
→ `200 Option` (le menu restant). `404 option_value_not_found`, `409 toggle_values_fixed`, `409 option_value_in_use` (`blockers` : lots), `409 default_value_required` (supprimer le défaut alors qu'il reste d'autres valeurs : désigner un autre défaut d'abord).

### Pièces
- `GET /api/backoffice/parts` → `200 { "items": [Part] }`
- `POST /api/backoffice/parts` `{ "name": "…", "reference"?: "…" }` → `201 Part` ; `409 part_name_taken`
- `PATCH /api/backoffice/parts/{partId}` `{ "name"?, "reference"? }` → `200 Part` ; `404 part_not_found`, `409 part_name_taken`
- `DELETE /api/backoffice/parts/{partId}` → `204` ; `404 part_not_found`, `409 part_in_use` (`blockers` : valeurs d'option, commandes de lot, historique de stock)

L'association pièce ↔ valeur se fait par `parts` sur la valeur (création ou `PATCH`).

---

## Lots

### Objet `Batch`

Deux **types** de lot (`kind`, fixé à la création, immuable) :
- `wholesale` (« Palette ») : achetée en gros, `quantity` et `purchasePrice` du lot entier, cycle de vie complet (sondage, précommande… clôture) ; on y vend exactement ses machines, même avant leur arrivée ;
- `stock` (« Stock ») : **un par modèle**, nommé « Stock {modèle} », permanent ; ni quantité ni prix d'achat (portés par ses réassorts) ; deux statuts seulement, `draft` (**en pause**, `statusLabel` « En pause ») et `on_sale` (**en vente**) ; on n'y vend que les machines **en main, `ok` et entièrement contrôlées** depuis leur dernière entrée en main (une machine `degraded` n'est jamais vendable depuis le stock). Alimenté par les réassorts, les transferts depuis une palette (dont la clôture) et les machines reçues en plus d'une palette.

Liste (`BatchSummary`) :
```json
{
  "id": "uuid", "name": "10 S19", "kind": "wholesale", "kindLabel": "Palette",
  "status": "preorder", "statusLabel": "Précommande",
  "model": { "id": "uuid", "name": "S19" },
  "quantity": 10, "purchasePrice": "1500000", "resaleUnitPrice": "180000",
  "createdAt": "…", "updatedAt": "…", "priorityEndsAt": null,
  "counters": {
    "paidMachines": 2, "pendingMachines": 1, "orderedMachines": 3,
    "capacity": 10, "availableStock": 7,
    "sellableMachines": 0, "expectedMachines": 0, "toCheckMachines": 0, "transferredOut": 0,
    "paidOrders": 1, "pendingOrders": 1, "interestedMachines": 4, "interestedUsers": 3,
    "attentionOrders": 0, "blockedUsers": 0
  },
  "transitions": [Transition]
}
```
Lot de stock en vente (même objet) :
```json
{
  "id": "uuid", "name": "Stock S19", "kind": "stock", "kindLabel": "Stock",
  "status": "on_sale", "statusLabel": "En vente",
  "quantity": null, "purchasePrice": null, "resaleUnitPrice": "52000", "priorityEndsAt": null,
  "counters": { "paidMachines": 1, "pendingMachines": 0, "orderedMachines": 1, "capacity": 4, "availableStock": 3,
                "sellableMachines": 3, "expectedMachines": 2, "toCheckMachines": 1, "transferredOut": 0, "…": "…" },
  "transitions": [{ "to": "draft", "action": "Mettre en pause", "kind": "pause", "noteRequired": false, "…": "…" }]
}
```

| Compteur | Sens |
|---|---|
| `paidMachines` | machines payées (lignes non remboursées de commandes payées) |
| `pendingMachines` | machines réservées par une facture en attente encore valide (30 min) |
| `orderedMachines` | payées + réservées : ce qui consomme le stock |
| `capacity` | places vendables du lot, fonction SQL `batch_capacity` : palette = `quantity` − machines transférées au stock − machines sorties du stock (manquantes, rebutées, perdues, mortes) ; lot de stock = machines vendables (en main, `ok`, contrôle complet depuis la dernière entrée en main) + machines des lignes actives |
| `availableStock` | `capacity` − `orderedMachines`, fonction SQL `batch_available_stock` : ce qui reste à vendre (lot de stock : « disponibles »). **Non bornée à 0** : une valeur négative signale un lot survendu (impossible après validation en base ; à afficher en alerte si elle apparaît) |
| `sellableMachines` | machines vendables, machine d'aucune ligne active (vue `batch_machine_summary`) : « en rayon » d'un lot de stock (≥ `availableStock`, l'écart = factures en attente et lignes payées pas encore attribuées) |
| `expectedMachines` | machines attendues : réassort ou palette pas encore reçus |
| `toCheckMachines` | machines en main à contrôler : jamais contrôlées, ou `ok` à recontrôler depuis leur retour en main (retournée, retrouvée) |
| `transferredOut` | palette : machines transférées vers le lot de stock (`0` pour un lot de stock) |
| `paidOrders`, `pendingOrders` | factures payées / en attente valides |
| `interestedMachines`, `interestedUsers` | wishlists actives (une par machine souhaitée) et utilisateurs distincts |
| `attentionOrders` | factures « à traiter » du lot (voir `GET /api/backoffice/orders/attention`) |
| `blockedUsers` | utilisateurs bloqués sur le lot après trop d'abandons (voir `GET /api/backoffice/order-blocks`) |

`quantity` et `purchasePrice` valent `null` pour un **lot de stock**. `statusLabel` : libellé du statut, sauf le lot de stock en brouillon : « En pause ». `kindLabel` : « Palette » ou « Stock ».

`priorityEndsAt` : fin de la journée de priorité (fonction SQL `batch_priority_ends_at`), `null` s'il n'y en a pas (lot ouvert sans sondage, aucune wishlist active) ; peut être passée.

Détail (`GET /batches/{id}`, et réponse de toute écriture) : les mêmes champs, plus :
```json
{
  "model": { "id": "uuid", "name": "S19", "hashrate": "95000000000000", "hashboardQtt": 3 },
  "editableFields": ["name", "quantity", "purchasePrice", "optionMaxQty"],
  "options": [{
    "id": "uuid", "kind": "choice", "title": "Kit de ventilation", "description": null, "position": 0,
    "hidden": false, "wishlistChoices": 2,
    "values": [{
      "id": "uuid", "label": "Silent kit", "isDefault": false, "position": 1,
      "price": "7500", "availability": "offered", "enabled": true, "canOffer": false,
      "priceOverride": "6000", "effectivePrice": "6000", "maxQty": 3, "used": 1,
      "interest": { "machines": 4, "users": 3 }
    }]
  }],
  "history": [
    { "id": "uuid", "from": null, "to": "draft", "note": null, "changedBy": "1", "createdAt": "…" },
    { "id": "uuid", "from": "draft", "to": "survey", "note": "Annonce Discord", "changedBy": "1", "createdAt": "…" }
  ],
  "restocks": [Restock],
  "transfers": [{
    "id": "uuid", "machineId": "uuid", "serial": "S19-F-0001" | null,
    "from": { "id": "uuid", "name": "10 S19" }, "to": { "id": "uuid", "name": "Stock S19" },
    "reason": "admin" | "batch_closed", "note": "Invendus" | null, "changedBy": "1", "createdAt": "…"
  }]
}
```
- `restocks` : réassorts du lot de stock, du plus ancien au plus récent (`[]` pour une palette ; objet `Restock` : voir « Lot de stock : réassort et transfert »).
- `transfers` : machines sorties de la palette vers le stock, ou entrées dans le lot de stock depuis une palette, du plus ancien au plus récent. `reason` : `batch_closed` (posé par la clôture de la palette), `admin` (transfert décidé par l'admin).
- `options` : les menus **applicables au lot** (fonction SQL `batch_menus`) : tous les menus du modèle en brouillon, l'instantané pris à la publication ensuite (un menu ajouté au modèle après la publication n'apparaît pas). Par menu :
  - `hidden` : menu masqué, sa valeur par défaut s'applique d'office ;
  - `wishlistChoices` : choix des manifestations d'intérêt actives dans ce menu autres que le défaut ; masquer le menu les ramène au défaut (à annoncer à l'admin avant).
- Par valeur : `availability` = `offered` (proposée), `withdrawn` (retirée, `enabled: false` au réglage) ou `not_offered` (lot publié, valeur ajoutée au catalogue depuis : non proposée) ; `enabled` = `availability === "offered"` ; `canOffer` : bouton « Proposer sur ce lot » (valeur `not_offered`, lot de Sondage à En transit) ; `priceOverride` (dérogation, `null` = prix catalogue), `effectivePrice` (prix appliqué), `maxQty` (`null` = illimité), `used` (machines payées ou réservées avec cette valeur, défaut compris, fonction SQL `batch_option_usage`), `interest` (mesure d'intérêt du sondage : manifestations d'intérêt actives ayant choisi cette valeur, défaut compris, en `machines` et en `users` distincts ; un menu masqué n'a aucun choix, ses valeurs restent à 0). Par lot : `counters.interestedMachines` / `interestedUsers`. Par produit d'option : `potentialQty` / `potentialDemand` (« Stock des produits d'options »).
- `history` : journal des statuts, du plus ancien au plus récent ; `changedBy` = identifiant auth-service de l'admin.
- `editableFields` : champs modifiables au statut courant (voir tableau plus bas) ; l'UI désactive les autres.

### Objet `Transition` (prochaines actions)

```json
{
  "to": "ordering", "toLabel": "Commande en cours", "action": "Confirmer la commande du lot",
  "kind": "forward", "noteRequired": false,
  "allowed": true, "blockers": [], "warnings": ["Aucune précommande payée : …"],
  "cancelsPendingOrders": 0
}
```
`transitions` liste **toutes** les sorties du statut courant, dans l'ordre d'affichage conseillé (la première est l'action principale ; `cancel` en dernier). `allowed: false` : bouton désactivé, `blockers` explique pourquoi. `warnings` : à faire confirmer par l'admin avant l'envoi. `kind` : `forward`, `backward` (correction d'erreur), `cancel`, ou `pause` (mise en pause d'un lot de stock : bouton secondaire, ce n'est pas la prochaine action du lot). `noteRequired` : un motif est obligatoire (`backward` et `cancel`). `cancelsPendingOrders` : nombre de factures en attente **sans versement**, réservation vivante, que la transition annulera (cible qui n'accepte pas de commande : En transit, Clôturé, Annulé ; `0` sinon), à annoncer dans la confirmation (un `warnings` le dit aussi). Compte lu à l'affichage : un paiement reçu entre-temps exclut sa facture.

### `GET /api/backoffice/batches`
Paramètres : `status` (liste séparée par des virgules, ex. `status=survey,preorder`), `modelId`, `kind` (`wholesale` ou `stock`), `page` (≥ 1, défaut 1), `pageSize` (1–200, défaut 50). Tri : dernière modification d'abord.
→ `200 { "items": [BatchSummary], "total": 12, "page": 1, "pageSize": 50, "statusCounts": { "draft": 3, "survey": 1, …, "cancelled": 0 } }`. `statusCounts` : nombre de lots par statut (les 12 statuts, `on_sale` compris, 0 compris), filtré par `modelId` et `kind` mais **pas** par `status` : il alimente les compteurs des filtres en une seule requête. `400 invalid_input` (statut ou type inconnu…).

### `POST /api/backoffice/batches`
```json
{
  "modelId": "uuid", "quantity": 10, "purchasePrice": "1500000",
  "resaleUnitPrice": "180000", "name": "Palette Bitmain",
  "optionValues": [
    { "optionValueId": "uuid-air-flow", "enabled": false },
    { "optionValueId": "uuid-silent", "priceOverride": "6000", "maxQty": 3 }
  ],
  "hiddenOptions": ["uuid-menu-nettoyage"]
}
```
Obligatoires : `modelId`, `quantity` (1–10 000), `purchasePrice` (prix du lot entier, > 0). Facultatifs : `kind` (défaut `wholesale`), `resaleUnitPrice` (prix unitaire de revente, > 0, requis pour publier), `name` (défaut `« {quantité} {modèle} »`), `optionValues`, `hiddenOptions`.

**Lot de stock** : `kind: "stock"`, **sans** `quantity` ni `purchasePrice` (envoyés : `400 invalid_input`, `issues` sur `quantity` / `purchasePrice`, « Un lot de stock n'a ni quantité ni prix d'achat : ils sont portés par ses réassorts ») ; nom par défaut « Stock {modèle} ». Un seul par modèle : `409 stock_batch_exists`, `details: { "batchId": "uuid" }` (le lot existant, à ouvrir ; vrai aussi pour deux créations simultanées). Il naît en pause (`draft`) ; le mettre en vente : `POST …/transitions` `{ "from": "draft", "to": "on_sale" }`. Le lot de stock est aussi créé d'office (en pause) par le premier transfert ou la première clôture d'une palette du modèle.
```json
{ "kind": "stock", "modelId": "uuid", "resaleUnitPrice": "52000", "optionValues": [{ "optionValueId": "uuid-silent", "priceOverride": "6000" }] }
```
Palette sans `quantity` ou `purchasePrice` : `400 invalid_input` (« Ce champ est obligatoire pour une palette »).

`optionValues` : un réglage par **valeur** d'option du modèle. `enabled` (défaut true), `priceOverride` (défaut null), `maxQty` (défaut null). Une valeur absente hérite du catalogue. La valeur par défaut d'un menu n'est jamais retirée (`409 default_value_withdrawn`) et reste gratuite (dérogation autre que `"0"` : `422 default_value_not_free`).

`hiddenOptions` : identifiants des **menus masqués** sur ce lot (bouton « Masquer ce menu ») ; la valeur par défaut s'y applique d'office, l'utilisateur n'a pas de choix. Liste complète.

Le lot naît au statut `draft` ; la création est la première ligne du journal.
→ `201 Batch`. `422 unknown_model`, `409 stock_batch_exists`, `422 unknown_option_value` (valeur d'un autre modèle), `422 unknown_option` (menu masqué inconnu), `409 default_value_withdrawn`, `422 default_value_not_free`.

### `GET /api/backoffice/batches/{batchId}`
→ `200 Batch`. `404 batch_not_found`.

### `PATCH /api/backoffice/batches/{batchId}`
Mêmes champs que la création, tous facultatifs, plus **`expectedUpdatedAt` obligatoire** et `confirmResetChoices` (facultatif, `true`). `optionValues`, s'il est envoyé, est la **liste complète** des réglages (une valeur absente revient au réglage neutre : proposée, prix catalogue, sans limite ; `[]` = tout neutre). `hiddenOptions`, s'il est envoyé, est la liste complète des menus masqués (`[]` = tout afficher).

Écriture ligne par ligne : après la publication, les réglages sont un instantané (une ligne par valeur) qui n'est jamais supprimé ; un réglage neutre est mis à jour, pas effacé. Régler une valeur `not_offered` : `409 option_value_not_offered` (la proposer d'abord).

Lot publié (Sondage) : retirer des valeurs (`enabled: false`) ou réafficher un menu ne doit pas laisser un menu visible avec moins de deux valeurs proposées (menu « choix » sans alternative, ou menu Avec/Sans dont « Avec » est retiré) : `409 menu_without_choice`, rien n'est écrit, message « Le menu « Kit de ventilation » propose moins de deux valeurs sur ce lot : ajoutez une valeur au catalogue, rétablissez une valeur retirée ou masquez le menu. » (plusieurs menus : « Les menus « A », « B » proposent… »). Masquer le menu dans la même requête est permis. En brouillon, la même règle est une condition de publication (pas un refus d'enregistrement).

Masquer un menu (Brouillon, Sondage) ramène au défaut les choix des manifestations d'intérêt dans ce menu ; réafficher leur redonne le défaut (0 €). Si des choix autres que le défaut existent (`wishlistChoices` > 0), la requête est refusée tant que `confirmResetChoices: true` n'est pas envoyé : `409 hidden_menu_has_choices`, message « Masquer ce menu ramènera N choix de manifestation(s) d'intérêt à la valeur par défaut. Confirmez pour continuer. » (à afficher dans la confirmation, puis renvoyer la même requête avec `confirmResetChoices: true`).

Retirer une valeur (`enabled: false` dans `optionValues`) ramène **tout de suite** au défaut du menu (0 €) les manifestations d'intérêt qui l'avaient choisie, à tout statut sauf clôturé ou annulé, sondage compris (v5j, fait par la base ; la wishlist et sa priorité restent, l'utilisateur est prévenu par `optionWithdrawals`). Si des wishlists actives l'ont choisie, la requête est refusée tant que `confirmResetChoices: true` n'est pas envoyé : `409 withdrawn_value_has_choices`, `details: { wishlists: N }`, message « Retirer « Silent kit » du lot ramènera N manifestation(s) d'intérêt à la valeur par défaut du menu (les personnes concernées en seront prévenues, leur priorité est conservée). Confirmez pour continuer. » (même confirmation que pour un menu masqué).

```json
{ "expectedUpdatedAt": "2026-10-06T10:00:00.123456Z", "quantity": 18, "name": null }
```

- `expectedUpdatedAt` : la valeur `updatedAt` du lot affiché, **renvoyée telle quelle** (chaîne ISO 8601, 6 décimales au plus ; un autre fuseau ou format ISO désignant le même instant est accepté). Sous verrou du lot (`FOR UPDATE`), le serveur la compare exactement (à la microseconde) à `updated_at` : si le lot a changé depuis (autre onglet, autre admin, changement de statut), `409 batch_modified`, rien n'est écrit : message « Le lot a été modifié entre-temps (autre onglet ou autre administrateur). Rechargez la page pour repartir de la version à jour : vos modifications n'ont pas été enregistrées. ». Absent ou mal formé : `400 invalid_input` (`path: "expectedUpdatedAt"`).
- Le contrôle a lieu même si aucun champ ne change. La réponse (`200 Batch`) porte le nouvel `updatedAt`, à utiliser pour l'enregistrement suivant ; une transition (`POST …/transitions`) change aussi `updatedAt`, sa réponse donne la nouvelle valeur.

- Un champ envoyé avec sa valeur actuelle est ignoré : l'UI peut renvoyer tout le formulaire.
- `name: null` remet le nom par défaut. Un nom resté par défaut suit les changements de quantité et de modèle ; un nom personnalisé ne bouge plus.
- Changer de modèle (brouillon seulement) efface les réglages d'options et les menus masqués, sauf si `optionValues` / `hiddenOptions` sont envoyés dans la même requête pour le nouveau modèle.

Champs modifiables par statut (`editableFields`) :

| Statut | Nom | Modèle | Quantité, prix d'achat | Prix de revente | Options retirées, dérogations (`optionAvailability`) | Quantités max (`optionMaxQty`) | Menus masqués (`hiddenOptions`) |
|---|---|---|---|---|---|---|---|
| Brouillon | oui | oui | oui | oui | oui | oui | oui |
| Sondage | oui | – | oui | oui (pas `null`) | oui | oui | oui |
| Précommande, Commande en cours | oui | – | oui | – | – | oui | – |
| Attente de réception, Contrôle, Tuning, Packaging | oui | – | – | – | – | oui | – |
| En transit | oui | – | – | – | – | – | – |
| Clôturé, Annulé | – | – | – | – | – | – | – |

Quantité et `maxQty` ne descendent jamais sous ce qui est déjà vendu ou réservé.

Lot de stock (`editableFields` selon son statut) :

| Statut | Nom | Modèle | Quantité, prix d'achat | Prix de revente | `optionAvailability` | `optionMaxQty` | `hiddenOptions` |
|---|---|---|---|---|---|---|---|
| En pause (`draft`) | oui | – | – | oui | oui | oui | oui, tant qu'aucune commande n'a de choix dans le menu |
| En vente (`on_sale`) | oui | – | – | oui (pas `null`) | oui | oui | – |

Le prix de revente et les options se modifient à tout moment : les factures existantes gardent leur instantané. En vente, les prix catalogue des valeurs proposées sont figés par la base (comme pour une palette publiée) : changer un prix sur le lot passe par `priceOverride`. `quantity` ou `purchasePrice` envoyés → `422 stock_batch_no_quantity` (« Un lot de stock n'a ni quantité ni prix d'achat : ils sont portés par ses réassorts. ») ; un autre champ hors du tableau → `409 batch_field_locked` (« Sur un lot de stock en vente, ces champs ne sont pas modifiables : « Modèle ». »). Masquer, en pause, un menu où une commande (payée ou en attente, configuration figée) a déjà un choix : `409 menu_visibility_locked` (« Des commandes de ce lot ont déjà un choix dans ce menu (N machines) : il ne peut plus être masqué. »).

→ `200 Batch`. `404 batch_not_found`, `409 batch_modified`, `409 batch_field_locked` (le message liste les champs), `422 stock_batch_no_quantity`, `409 menu_visibility_locked`, `409 quantity_below_sold`, `409 max_qty_below_sold`, `409 hidden_menu_has_choices`, `409 withdrawn_value_has_choices`, `409 menu_without_choice`, `409 option_value_not_offered`, `422 resale_price_required`, `422 unknown_model`, `422 unknown_option_value`, `422 unknown_option`, `409 default_value_withdrawn`, `422 default_value_not_free`.

### `POST /api/backoffice/batches/{batchId}/offered-values`
« Proposer sur ce lot » une valeur ajoutée au catalogue après la publication (`canOffer: true`). Palette de Sondage à En transit, lot de stock en vente (en pause, tout le catalogue est proposé : `409 batch_draft`).
```json
{ "optionValueId": "uuid", "priceOverride": "3000", "maxQty": 2 }
```
`priceOverride` et `maxQty` facultatifs (`null` : prix catalogue, illimité). Change `updatedAt` du lot (un formulaire ouvert avant devient périmé).
→ `201 Batch`. `404 batch_not_found`, `409 batch_draft` (en brouillon tout le catalogue est proposé : utiliser le formulaire), `409 batch_finished` (clôturé, annulé), `409 option_not_applicable` (menu ajouté après la publication), `409 option_value_already_offered`, `422 unknown_option_value`, `422 default_value_not_free`.

### `POST /api/backoffice/batches/{batchId}/transitions`
Change le statut (insère une ligne au journal ; le statut n'est jamais écrit autrement).
```json
{ "to": "preorder", "from": "survey", "note": "facultatif, obligatoire si noteRequired" }
```
`from` (**obligatoire**) : le statut affiché à l'écran ; s'il a changé entre-temps (autre admin, double clic), la requête est refusée au lieu d'appliquer une action périmée. Absent ou inconnu : `400 invalid_input` (`path: "from"`, message « Statut de départ attendu : renvoyez le statut du lot affiché à l'écran »).

→ `201 Batch` (à jour, avec les nouvelles `transitions`) + `warnings` (R4b : `[]`, ou à la clôture d'une palette qui attendait encore des machines `[{ "code": "palette_has_expected", "message": "…", "expected": 2 }]` : la clôture est faite, afficher l'alerte). Erreurs :
| Code | Cas |
|---|---|
| `400 invalid_input` | `from` absent ou inconnu, `to` inconnu |
| `404 batch_not_found` | |
| `409 batch_status_changed` | `from` ≠ statut courant |
| `409 transition_not_allowed` | couple absent de la table (saut d'étape, retour interdit, lot terminé) |
| `422 note_required` | motif manquant pour un retour arrière ou une annulation |
| `409 inspection_expected_machines` | (jalon 5 bis) sortie du Contrôle (`→ tuning` ou `→ packaging`) avec des machines encore attendues ; `details.machines: [{ machineId, serial }]` |
| `409 inspection_surplus_orders` | sortie du Contrôle avec des commandes payées en trop (`batch_surplus_lines`) ; `details.lines: [{ lineId, orderId, position, machineId }]`, `details.orderIds` |
| `409 inspection_lines_to_replace` | sortie du Contrôle avec une ligne payée dont la machine est défectueuse ou perdue, ou au montage non conforme (`machine_fits_configuration`) ; message distinct pour chaque cas ; `details.lines: [{ lineId, orderId, position, machineId, machineSerial, problem: "faulty" \| "lost" \| "mounting" }]`, `details.orderIds` |
| `409 packaging_unassigned_lines` | `→ packaging` (du Contrôle ou du Tuning) tant qu'une ligne payée n'a pas de machine ; `details.lines` (`machineId: null`), `details.orderIds`. Les machines libres ne bloquent jamais (elles partent au stock) |
| `409 transition_blocked` | condition métier non remplie ; `message` = les `blockers` |
| `409 batch_has_paid_orders` | annulation avec commande payée (garde de la base) |
| `422 resale_price_required` | publication sans prix de revente (garde de la base) |

**Lot qui ferme les commandes et factures en attente** (décisions Hugo 2026-10-09, migrations `v5h` puis `v5i`) : toute transition vers un statut qui n'accepte pas de commande (`batch_accepts_orders` faux : **En transit, Clôturé, Annulé**, et la mise en pause d'un lot de stock) annule, dans la même transaction, les factures du lot **en attente, sans aucun versement et dont la réservation court encore** : elles passent à `cancelled` (réservation libérée, `cancelledAt` posé par la base) avec **`cancelReason: "batch_closed"`** (posée par la base, migration `v5l`) ; une facture que le client avait annulée lui-même avant la fermeture garde `cancelReason: "user"`. L'écran lit la cause dans `cancelReason`, jamais dans l'état actuel du lot (`batch.status`, `batch.acceptsOrders` ne servent qu'à nommer le statut du lot : « Lot annulé », « lot fermé aux commandes »). **Aucune facture ni adresse de paiement n'est supprimée.** Une facture avec un versement partiel n'est pas touchée : elle reste `pending_payment` et devient « à traiter » (`admin_decision`, lot fermé aux commandes). Un versement reçu ensuite sur l'adresse d'une facture annulée n'est jamais remboursé d'office : « à traiter », l'admin rembourse (`shop_stock`, `admin_other`, `late_payment_no_room`). Les factures déjà expirées sont laissées telles quelles (affichées `expired`). Les factures sont verrouillées avant le lot (même ordre que les paiements, pour toute cible qui ferme les commandes) : un paiement validé juste avant la transition exclut sa facture, sans interblocage. La confirmation (`cancelsPendingOrders`, `warnings`) annonce ces annulations. Une transition qui garde le lot ouvert (ex. Précommande → Commande en cours) ne touche aucune facture.

### Machine à états

Statuts : `draft` Brouillon, `survey` Sondage, `preorder` Précommande, `ordering` Commande en cours, `awaiting_reception` Attente de réception, `inspection` Contrôle, `tuning` Tuning, `packaging` Packaging, `in_transit` En transit, `closed` Clôturé, `cancelled` Annulé, `on_sale` En vente (lot de stock seulement). Les libellés et la table sont exportés par `src/server/batch-status.ts` (module pur, sans accès base).

La base valide les couples **par type de lot** (`batch_transition_allowed(kind, from, to)`) ; le domaine a la même table par type (`TRANSITIONS.wholesale`, `TRANSITIONS.stock`, test d'égalité exhaustif avec la base, création comprise). Le grand tableau ci-dessous est celui d'une palette. Lot de stock :

| De → vers | Action | `kind` | Condition (bloquante) | Motif |
|---|---|---|---|---|
| draft → on_sale | Mettre en vente | `forward` | prix de revente renseigné ; chaque menu visible propose au moins deux valeurs (comme une publication : instantané des menus) ; avertit si aucune machine n'est disponible | |
| on_sale → draft | Mettre en pause | `pause` | – ; avertit : plus visible ni commandable, les commandes payées restent à servir ; les factures en attente sans versement sont annulées (`cancelsPendingOrders`) | |

Rien d'autre pour un lot de stock (ni sondage, ni annulation, ni clôture) ; un statut de palette est refusé (`409 transition_not_allowed`, « … : un lot de stock est en vente ou en pause »), comme `on_sale` pour une palette.

| De → vers | Action | Condition (bloquante) | Motif |
|---|---|---|---|
| draft → survey | Publier pour sondage | prix de revente renseigné ; chaque menu visible (« choix » ou Avec/Sans) propose au moins deux valeurs | |
| draft → preorder | Ouvrir les précommandes (sans sondage) | idem ; avertit : personne n'est prioritaire | |
| draft → ordering | Commander sur fonds propres | idem | |
| survey → preorder | Ouvrir les précommandes | – | |
| survey → draft | Dépublier | – (les wishlists sont conservées) | oui |
| preorder → ordering | Confirmer la commande du lot | – ; avertit s'il n'y a aucune précommande payée | |
| ordering → awaiting_reception | Confirmer l'attente de réception | – | |
| awaiting_reception → inspection | Confirmer la réception | au moins une machine reçue | |
| inspection → tuning | Passer en tuning | toutes les machines reçues contrôlées ; au moins une machine vendue avec une option à pièces ; commandes de pièces livrées | |
| inspection → packaging | Passer en packaging | toutes les machines reçues contrôlées ; aucune option à monter | |
| inspection → awaiting_reception | Revenir à l'attente de réception | aucune machine contrôlée ni attribuée | oui |
| tuning → packaging | Passer en packaging | aucune machine en montage | |
| tuning → inspection | Revenir au contrôle | – | oui |
| packaging → in_transit | Confirmer la remise au transporteur | au moins une machine expédiée | |
| packaging → tuning / inspection | Revenir au tuning / contrôle | aucune machine expédiée | oui |
| in_transit → closed | Clôturer le lot | chaque machine vendue attribuée et livrée | |
| draft, survey, preorder, ordering, awaiting_reception → cancelled | Annuler le lot | aucune commande payée (rembourser d'abord) ; avertit s'il reste des factures en attente | oui |

Menu visible proposant moins de deux valeurs (valeurs du catalogue non retirées du lot) : menu « choix » sans alternative, ou menu Avec/Sans dont « Avec » est retiré ; un menu masqué n'est pas concerné : blocker « Le menu « Firmware » propose moins de deux valeurs sur ce lot : ajoutez une valeur au catalogue, rétablissez une valeur retirée ou masquez le menu. », renvoyé en `409 transition_blocked` si la transition est quand même demandée.

**Clôture d'une palette** (refonte R2) : la transition annonce les invendus qui partiront au stock (`warnings` : « N machines invendues partiront au lot de stock du modèle (créé en pause s'il n'existe pas). »), puis, dans la transaction de `in_transit → closed` (machines de la palette verrouillées avant le lot par le serveur), la base transfère au lot de stock du modèle chaque machine invendue (machine d'aucune ligne non remboursée) en main ou retournée (journal `MachineTransfer`, motif `batch_closed`, auteur de la transition) ; le lot de stock est créé en pause (« Stock {modèle} », journal : « Créé à la clôture du lot … ») s'il n'existe pas (même règle en base que le transfert, `stock_batch_of`). Aucune machine n'est recréée ; les machines attendues, manquantes, perdues, au rebut ou livrées restent dans la palette. Si la palette a encore des lignes payées sans machine, le COMMIT est refusé (`Batch_stock`) : la condition « chaque machine vendue attribuée et livrée » l'évite.

Aucun retour vers Sondage ou Brouillon une fois la précommande ouverte ; `closed` et `cancelled` sont terminaux. Les conditions sur les machines s'appuient sur les routes machines (refonte R3a) ; celles sur les pièces (montage) sur le jalon 6. Depuis la v6, l'entrée en Attente de réception **génère les machines du lot** (une par place, voir ci-dessous) et la quantité du lot n'est plus modifiable ensuite (la base la fige aussi).

---

## Machines : réception, contrôle, attribution, expédition (jalon 5, refonte R3a)

**État : livré (backend, refonte R3a, 2026-11-10).** Whitelist pour toutes les routes. Code : `src/server/machine-status.ts` (table des transitions, motif obligatoire, actions proposées ; domaine pur, importable par l'UI, **identique** à `machine_transition_allowed`, `machine_change_needs_note` et `machine_in_hand` : test d'égalité exhaustif `tests/integration/machine-status-vs-sql.test.ts`), `src/server/machines.ts` (lectures, écritures, remboursement des commandes en trop), routes `src/app/api/backoffice/machines/**`, `…/batches/[batchId]/{machines,receptions,extra-machines,assignments/auto}`, `…/order-lines/[lineId]/{assignment,replacement}`, `…/stock`. Tests : `tests/integration/machines-api.test.ts` (dont parcours complets palette et stock), unitaires `tests/unit/server/machine-status.test.ts`.

### Principes (imposés par la base)

- **Machine et lot** : la machine est un objet durable. Origine immuable, exactement une : `originBatchId` (palette d'où elle vient) ou `restockId` (réassort du lot de stock) ; `batchId` = lot auquel elle appartient aujourd'hui, changé seulement par un transfert (palette → lot de stock du même modèle). Ses statuts ne dépendent **pas** du statut du lot, sauf : lot annulé = machines figées, et attribution du Contrôle à En transit (palette).
- **Génération** : à l'entrée d'une palette en Attente de réception, la base crée une machine `expected` par place (`Batch.quantity`) ; rien de plus après un retour Contrôle → Attente de réception, ni après un transfert. Un réassort crée ses machines `expected` dans le lot de stock. Une machine reçue **en plus** d'une palette se crée directement dans le lot de stock (`POST …/extra-machines`). Jamais de suppression.
- **Vendable (lot de stock)** : en main, `ok`, et chaque hashboard saisie `ok` **depuis** `inHandSince` (`machine_sellable`) : une machine retournée ou retrouvée se recontrôle (« Tout OK ») avant d'être de nouveau disponible ; `degraded` n'est jamais vendable depuis le stock. La « quantité reçue » d'un lot est `summary.received`.
- **Statuts** : `logisticalStatus` et `functionalStatus` ne changent que par le journal (`POST /machines/status`), qui vérifie l'état affiché (`from`), le couple autorisé, le motif et que le lot n'est pas annulé. Les dates `receivedAt` (première réception), `inHandSince` (dernière entrée en main), `shippedAt`, `deliveredAt` sont posées par la base.
- **Contrôle** : sur une machine reçue et en main (`in_stock`, `in_preparation`, `ready`), quel que soit le statut du lot. `ok` exige toutes les hashboards `ok` (le serveur les saisit d'office quand on passe à `ok`) ; une hashboard `degraded` ou `dead` impose `degraded` ou `faulty`. Jamais de retour à `unknown`. Corriger un état déjà saisi exige un motif.
- **Machine morte** (`faulty`) : sort du stock dès qu'elle est marquée (sauf si elle est encore la machine d'une ligne : elle compte alors par sa ligne jusqu'au remplacement). Mise au rebut (`scrapped`) seulement si `faulty` ; **réversible** (jalon 5 bis) : retour `scrapped → in_stock` avec motif obligatoire (journal `MachineStatusChange`), la machine reste `faulty` et se recontrôle ; refusé si la place a été reprise (`Machine_scrap_return_place`, lot survendu).
- **Numéro de série** (jalon 5 bis, backend livré) : obligatoire dès la réception (`Machine_serial_received_check`) : posé **avant** `expected/missing → in_stock`, donc avant le contrôle des hashboards, la mise en vente et l'attribution ; il ne s'efface plus. Le backend écrit le numéro avant le journal (réception en bloc, machine en plus) ; sans numéro (ni numéro déjà saisi par `PATCH`) : `422 serial_required` (`details.machineIds`) ; même code sur `POST /machines/status` vers `in_stock`. Le numéro ne s'efface plus une fois la machine reçue.
- **Sortie du Contrôle** (jalon 5 bis, trigger `BatchStatusTransition_1b_inspection_exit`) : `inspection → tuning|packaging` refusé tant qu'une machine est `expected` (`BatchStatusTransition_inspection_expected`), qu'une commande payée est en trop (`…_inspection_surplus`) ou qu'une ligne payée a une machine morte ou perdue (`…_inspection_replace`) ; `→ packaging` refusé tant qu'une ligne payée n'a pas de machine (`…_packaging_unassigned`). Les machines libres ne bloquent pas (elles partent au stock).
- **Motif de remboursement** (jalon 5 bis) : table `MachineRefundCause` (`case_code` → `cause`), fonction SQL `machine_refund_cause(case_code)` ; cas `faulty`, `degraded` → `shop_defective_machine`, `missing`, `lost` → `shop_stock`. Extensible par une ligne : le domaine lit le motif dans la table (`422 refund_cause_unknown`, `details.case`, si le cas n'y est pas).
- **Attribution** : machine **du lot de la ligne**, ligne active d'une facture payée. Palette : machine en main, contrôlée `ok` ou `degraded` (motif **et acceptation explicite du client** pour `degraded` : `OrderLineAssignment.degraded_accepted_by_user_id` = le client de la ligne, `degraded_accepted_at` = date de l'acceptation, jamais future ; refusé sinon : `OrderLineAssignment_degraded_acceptance`), lot au Contrôle, Tuning, Packaging ou En transit. Lot de stock : machine vendable (jamais `degraded`), lot en vente **ou en pause**. Remplacement et retrait avec motif ; jamais pour une machine remise au transporteur ou livrée (une machine perdue se remplace).
- **Verrous** (une seule transaction) : factures (`FOR NO KEY UPDATE`, par id) → lignes → machines (par id) → lot(s). Toute écriture sur des machines les verrouille par id ; la clôture d'une palette verrouille ses machines avant d'insérer la transition.

### Machines en moins : remboursement des commandes en trop

Toute écriture qui laisserait un lot avec plus de lignes payées et réservées que de machines utilisables (machine qui meurt, manque, se perd ; machine vendable du stock qui se dégrade ; remplacement qui prend la dernière machine vendable d'un lot de stock plein) est détectée **avant le COMMIT** (`batch_available_stock` < 0, que `Batch_stock` refuserait). Les lignes à rembourser sont les premières de `batch_surplus_lines` (source unique en base), autant que de places manquantes. Ordre (R4b) : d'abord les lignes **à servir** (sans machine, machine morte, ou machine encore en main dont le remboursement rend la place : palette, machine en vie ni en transit ni livrée ; lot de stock, machine vendable), puis les lignes **servies** ou dont la machine ne se revend pas (en transit, livrée ; stock : dégradée, à recontrôler) ; dans chaque groupe, paiement le plus récent d'abord. Une commande déjà expédiée ou livrée n'est donc jamais annoncée tant qu'une autre peut l'être (les comptes font qu'elle ne l'est jamais). Colonne `frees_place` : le remboursement de la ligne rend une place au lot (faux pour une ligne dont la machine est morte, qui comptait déjà par sa ligne) ; **seules ces lignes comblent un manque** avant le COMMIT, le reste du manque vient des factures en attente (`machine_shortage_reserved`).

1. Sans confirmation : `409 machine_shortage`, **rien n'est écrit** :
   ```json
   { "error": { "code": "machine_shortage",
     "message": "Il n'y a plus assez de machines pour toutes les commandes payées du lot : la commande payée la plus récente sera remboursée pour une machine (frais à la charge de la boutique). Confirmez pour continuer.",
     "details": { "refunds": [{ "lineId": "uuid", "orderId": "uuid", "batchId": "uuid", "paidAt": "…", "contactEmail": "bob@exemple.fr", "amount": "50000" }] } } }
   ```
2. L'admin confirme en renvoyant **la même requête** avec `"confirmRefunds": ["lineId", …]` = exactement les `lineId` annoncés. Même transaction : factures verrouillées d'abord, lignes annulées par le moteur de remboursement des commandes (comme « Annuler des machines » : remboursement au prorata, `initiatedBy: "admin"`, frais à la charge de la boutique), puis l'écriture. Motif : `shop_defective_machine` (machine `faulty` ou `degraded`), sinon `shop_stock` (manquante, perdue). Liste qui ne correspond plus (autre paiement entre-temps) : `409 machine_shortage` avec la liste à jour ; lot qui change pendant l'exécution : `409 retry`.
3. Si les lignes payées ne suffisent pas (des **factures en attente** occupent les dernières places) : `409 machine_shortage_reserved`, `details: { "pendingOrders": 1, "refunds": [] }`, message « Il manquerait 1 machine : 1 facture en attente de paiement occupe les dernières places du lot. Attendez la fin de leur réservation (30 minutes au plus), puis recommencez. » (question ouverte 4 du jalon 5).

**Marquage d'une machine (`POST /api/backoffice/machines/status`, décision de Hugo du 2026-11-16) : jamais refusé** (défectueuse, dégradée, manquante, perdue, puis rebut ; une machine défectueuse se marque toujours, une machine déjà attribuée aussi : sa ligne reste à remplacer). Pas de `409 machine_shortage` ni de confirmation : les commandes payées en trop sont **remboursées dans la même transaction** (mêmes lignes, même motif, `refunds` dans la réponse, `confirmRefunds` ignoré) et les **factures en attente en trop sont annulées** (la plus récente d'abord, `cancelReason: "admin"`, jamais un abandon). Seule exception : une facture en attente qui a déjà reçu un versement ne s'annule pas (`order_cancel_paid`) ; si elle occupe la dernière place, `409 machine_shortage_reserved` (attendre son expiration, 30 minutes au plus). Le flux « annonce puis confirmation » ci-dessus reste celui de l'**attribution et du remplacement** (`assignment`, `replacement`).

La réponse d'une écriture qui peut rembourser porte `refunds` (lignes remboursées, `[]` sinon). `POST /machines/status` porte en plus `cancelledOrders` : les factures en attente annulées pour libérer des places, `[{ "orderId": "uuid", "cause": "admin" }]` (`[]` sinon) ; l'UI les affiche à côté des remboursements.

**Ligne à remplacer sans machine libre (décision de Hugo du 2026-11-16)** : quand une machine attribuée est défectueuse ou perdue et qu'aucune machine libre, en main et OK ne peut la remplacer (`replacementAvailable: false` dans `GET /batches/{id}/machines`), « à remplacer » n'a plus de sens : l'admin annule la ligne (`POST /api/backoffice/orders/{orderId}/cancel-lines` avec `lineIds: [lineId]`) ou toute la facture payée (même route sans `lineIds`), avec `cause` = `refundCause` de la ligne (motif de `MachineRefundCause` : `shop_defective_machine` pour une machine morte ou dégradée, `shop_stock` pour une perdue ou manquante). La route accepte déjà ces cas (machine morte, perdue, expédiée ; facture payée) : remboursement `initiatedBy: "admin"`, frais à la charge de la boutique, jamais un abandon ni une pénalité pour le client.

### Montage des machines à option (kit) : plan, déclaration, conformité (2026-11-19)
Une valeur d'option est « à kit » quand elle a des produits (`OptionValuePart`). Le **montage exigé** d'une ligne est l'ensemble des valeurs à kit de sa configuration (vide : machine brute) ; le **montage** d'une machine (`MachineMounting`, `Machine.mounting`) est l'ensemble des valeurs à kit déclarées montées sur elle (vide : brute). Règle unique en base, `machine_fits_configuration(machine, configuration)` : montage **identique** (ni kit en trop, ni kit manquant) et, pour une ligne à kit, machine **prête** (ou déjà partie).
- **Plan de montage** (`mountingPlan` de `BatchMachines`) : le backoffice dit au technicien quoi monter. Une entrée par montage exigé par des lignes payées : `{ key, optionValueIds, items: [{ optionValueId, option, value }], lines, inPreparation, ready, toBuild }` (`lines` : lignes sans machine ou à machine non conforme ; `toBuild` = max(0, `lines` − `inPreparation` − `ready`), machines libres en montage ou prêtes avec ce montage).
- **Déclaration** : `POST /machines/status`, élément `mounting: [optionValueId…]` (seulement avec `to.logistical` = `in_preparation` ou `ready`, sinon `400 invalid_input`), posé avant le changement ; `[]` = machine brute, absent = inchangé. Écriture refusée une fois la machine prête ou partie (`409 mounting_machine_status`, `MachineMounting_machine_status`) pour une valeur inconnue ou d'un menu d'un autre modèle que celui de la machine (`422 mounting_unknown_value`, `MachineMounting_value`) et pour une valeur sans kit (`422 mounting_no_kit`, `MachineMounting_kit`). « Interrompre le montage » et tout retour `ready → in_stock` effacent le montage.
- **Attribution explicite uniquement** : le montage ne lie jamais la machine à une commande. L'attribution (`assignment`, `assignments/auto`, `replacement`, vente manuelle, attribution à l'encaissement d'un lot de stock) refuse une machine non conforme (`409 mounting_mismatch`, `OrderLineAssignment_mounting`) ; les attributions automatiques ne choisissent que des machines conformes et laissent la ligne sans machine sinon.
- **Machine déjà attribuée qui n'est pas conforme** (attribuée avant, puis démontée) : `MachineLine.mounting.conform: false` (« Montage non conforme »), comptée dans `lines_to_replace` de `batch_machine_summary` et, à part, dans `lines_to_remount` (machine ni défectueuse ni perdue : seul le montage est en cause) ; elle bloque la sortie du Contrôle (base : `BatchStatusTransition_inspection_replace` ; blocage « … machine au montage non conforme à la commande : remontez-la avec les kits de la commande, ou remplacez-la. ») ; elle n'est **jamais remise au transporteur** (`409 mounting_mismatch`, `MachineStatusChange_mounting`) : `Machine.nextChanges` de `in_transit` est alors `allowed: false` avec la raison dans `blockers`, l'UI grise le bouton avant la saisie du suivi. Correction sans retirer l'attribution : « Démarrer le montage » sur la machine attribuée avec le bon montage, puis « Montage terminé ».
- `MachineLine` : `mounting: { required: [{ optionValueId, option, value }], conform: bool | null }` (`null` sans machine) et `fittingMachineIds` (machines attribuables à la ligne : même règle que la base).
- **Kit exigé** : une valeur à kit choisie par une ligne active d'une facture payée garde au moins un produit (`409 option_kit_required`, voir `PATCH /option-values/{valueId}`) : sinon son montage exigé se viderait et la ligne recevrait une machine brute.
- Non fait : la sortie du stock de kits (`kit_mounted`) reste saisie à la main sur l'écran des produits ; elle n'est pas déduite du montage.

### Machine à états d'une machine (`logisticalStatus`)

| De → vers | Action (`nextChanges[].action`) | Motif | Condition (base) |
|---|---|---|---|
| expected → in_stock | Marquer reçue | | lot non annulé (comme toutes les lignes) ; numéro de série déjà posé (`Machine_serial_received_check`) ; pose `inHandSince` |
| expected → missing | Marquer manquante | oui | sort du stock (commande en trop remboursée, `shop_stock`) |
| missing → in_stock | Retrouvée | oui | pose `inHandSince` |
| in_stock → ready | Marquer prête | | `ok` ou `degraded` |
| in_stock → in_preparation | Démarrer le montage | | `ok` ou `degraded` (jalon 6) |
| in_stock → scrapped | Mettre au rebut | oui | `faulty` |
| scrapped → in_stock | Annuler la mise au rebut (avertissement avant validation du rebut) | oui | reste `faulty`, à recontrôler ; refusé si la place est reprise (`Machine_scrap_return_place`) |
| in_preparation → ready | Montage terminé | | |
| in_preparation → in_stock | Interrompre le montage | oui | |
| ready → in_transit | Remettre au transporteur | | machine d'une ligne active de son lot (facture payée), quel que soit le statut du lot |
| ready → in_stock | Retour en stock | oui | |
| in_transit → delivered | Marquer livrée | | terminal |
| in_transit → lost / returned | Marquer perdue / retournée | oui | |
| returned → in_stock, lost → in_stock | Remettre en stock / Retrouvée (à recontrôler) | oui | pose `inHandSince` : à recontrôler |

État fonctionnel : `unknown` → `ok` / `degraded` / `faulty` (machine en main) ; entre `ok`, `degraded`, `faulty` avec motif ; jamais vers `unknown`. Une machine `faulty` n'est jamais `in_preparation`, `ready` ni `in_transit`. Le même appel peut changer les deux (ex. reçue et contrôlée `faulty` d'un coup).

Libellés (`machine-status.ts`) : logistique `Attendue`, `En stock`, `En montage`, `Prête`, `En transit`, `Livrée`, `Manquante`, `Perdue`, `Retournée`, `Au rebut` ; fonctionnel `Non contrôlée`, `OK`, `Dégradée`, `Défectueuse` ; hashboard `OK`, `Dégradée`, `Morte`.

### Objet `Machine`
```json
{ "id": "uuid", "model": { "id": "uuid", "name": "S19", "hashboardQtt": 3 },
  "batchId": "uuid", "batch": { "id": "uuid", "name": "10 S19", "kind": "wholesale", "status": "inspection", "statusLabel": "Contrôle" },
  "originBatchId": "uuid" | null, "originBatch": { "id": "uuid", "name": "10 S19" } | null, "restockId": "uuid" | null,
  "customNumber": 1, "serial": "S19-F-0001" | null, "psuSerial": "APW12-…" | null,
  "logisticalStatus": "in_stock", "logisticalLabel": "En stock", "functionalStatus": "ok", "functionalLabel": "OK", "note": null,
  "receivedAt": "…" | null, "inHandSince": "…" | null, "shippedAt": null, "deliveredAt": null,
  "hashboards": [{ "index": 0, "status": "ok" | "degraded" | "dead" | null, "checkedBy": "1" | null, "updatedAt": "…" | null, "current": true }],
  "line": null | { "lineId": "uuid", "orderId": "uuid", "position": 1, "paidAt": "…", "customer": { "authUserId": "1005", "contactEmail": "…" } },
  "inHand": true, "sellable": true, "toRecheck": false, "assignable": true,
  "nextChanges": [{ "to": "ready", "toLabel": "Prête", "action": "Marquer prête", "noteRequired": false, "allowed": true, "blockers": [] }],
  "updatedAt": "2026-10-13T10:00:00.123456Z" }
```
- `hashboards` : une entrée par hashboard du modèle, `status: null` = jamais contrôlée ; `current` : saisie depuis la dernière entrée en main (sinon à ressaisir pour être vendable depuis le stock).
- `sellable` : `machine_sellable` (lot de stock : « disponible ») ; `toRecheck` : en main et `ok` mais hashboards à ressaisir depuis son retour en main ; `assignable` : attribuable à une ligne de son lot (palette : en main, `ok` ou `degraded` ; stock : vendable), machine d'aucune ligne active.
- `nextChanges` : transitions logistiques sortantes avec les conditions connues côté serveur (`blockers`) ; l'UI affiche tout, le serveur décide.
- `updatedAt` : à la microseconde, à renvoyer tel quel dans `expectedUpdatedAt` (comme `Batch`).

### `GET /api/backoffice/machines`
Paramètres : `batchId`, `modelId`, `logistical` et `functional` (listes séparées par des virgules), `q` (recherche dans `serial` et `psuSerial`, sous-chaîne, sans tenir compte de la casse ; ou `customNumber` exact), `page` (≥ 1), `pageSize` (1–500, défaut 100). Tri : lot (création), puis création de la machine.
→ `200 { "items": [Machine], "total": 12, "page": 1, "pageSize": 100, "exactMatchId": "uuid" | null }`. `exactMatchId` (R4b) : la machine dont un numéro de série (machine ou alimentation) est **exactement** `q` (casse ignorée, autres filtres ignorés) ; `null` : aucune ou plusieurs. L'UI ouvre alors sa fiche. `400 invalid_input` (statut inconnu…).

### `GET /api/backoffice/machines/{machineId}`
→ `200 Machine` plus `statusChanges` (journal, du plus ancien au plus récent : `{ id, fromLogistical, toLogistical, fromFunctional, toFunctional, note, changedBy, createdAt }`), `assignments` (journal des lignes où la machine est passée : `{ id, lineId, orderId, position, machineId, reason, changedBy, createdAt }`, `machineId: null` = retrait ; `changedBy: null` = attribution automatique par le système à l'encaissement d'une commande en ligne sur un lot de stock) et `transfers` (`{ id, from: { id, name }, to: { id, name }, reason, note, changedBy, createdAt }`). `404 machine_not_found`.

### Envoi d'une facture (`Shipment`, R6 lot 1 : contrat SQL ; lot 2 : routes et DTO ; UI : lot 3)

Le transporteur et le suivi ne sont plus portés par la machine (colonnes `carrier`, `tracking_number`, `tracking_url` supprimées de `Machine`) mais par l'**envoi de la facture** : table `Shipment`, une ligne par facture (`UNIQUE(order_id)`, constraint `Shipment_order_id_key`). Pas de frais de livraison (jalon L2).

| Colonne | Écrite par | Règle |
|---|---|---|
| `order_id` | application, à la création | facture **payée** (`Shipment_order_paid`), immuable (`Shipment_immutable`) |
| `carrier`, `tracking_number`, `tracking_url` | application, à tout moment | `tracking_url` en http/https (`Shipment_tracking_url_check`) |
| `shipped_at` | **base** | première machine de la facture passée `in_transit`, jamais recalée |
| `delivered_at` | **base** | une machine livrée et plus aucune machine d'une ligne active à acheminer (statuts `expected`, `missing`, `in_stock`, `in_preparation`, `ready`, `in_transit` : aucune) ; évaluée à chaque passage à `delivered`, `lost` ou `returned` ; posée une fois |
| `created_at`, `updated_at` | base | horloge de la base |

- Écriture applicative de `shipped_at` / `delivered_at` : refusée (`Shipment_new` à l'insertion, `Shipment_dates_via_change` ensuite). CHECK `Shipment_delivered_at_check` : `delivered_at` suppose `shipped_at` et lui est postérieure. Jamais supprimé (`Shipment_no_delete`).
- **Création** : par l'application avant la remise (transporteur donné d'avance, `INSERT` puis `UPDATE` libres des trois champs de suivi) ou par la base (ligne vide) à la première remise au transporteur : l'application peut donc faire un `upsert` sur `order_id` avant ou après le changement de statut.
- **Un envoi ne part que complet** : une machine ne passe `in_transit` que si **toutes** les lignes actives (non remboursées) de sa facture ont une machine attribuée (`Shipment_complete`, `check_violation`, en plus de `Machine_shipped_assigned`). Les machines d'une facture peuvent ensuite être remises une à une.
- **Incident après expédition** : une machine `lost` ou `returned` n'annule pas l'envoi ; ses dates restent, le statut de la machine porte l'incident. Si tout est perdu ou retourné, `delivered_at` reste `NULL`.
- **Routes (lot 2)** : pas de route dédiée. Le suivi s'écrit par `tracking` sur `POST /machines/status` (élément `to.logistical: "in_transit"` seulement, sinon `400 invalid_input`) ou par `carrier` / `trackingNumber` / `trackingUrl` sur `PATCH /machines/{id}` ; le serveur fait un `upsert` `Shipment` sur la facture payée de la machine (ligne active), en n'écrivant que les champs donnés (`null` ou `""` efface). Toutes les machines d'une facture partagent le même suivi. Machine sans ligne active d'une facture payée : `409 shipment_no_order`. Les dates ne s'écrivent jamais depuis l'API.
- **DTO** : `shipment` = `{ "carrier": "DHL" | null, "trackingNumber": … | null, "trackingUrl": … | null, "shippedAt": ISO | null, "deliveredAt": ISO | null }`, ou `null` si la facture n'a pas d'envoi. Présent sur la **facture** (`Order` et `AdminOrder`, mêmes routes que `paymentMethod`) et sur la **machine** (`Machine` et `MachineDetail`, via la facture de sa ligne active). `carrier`, `trackingNumber` et `trackingUrl` ne sont plus au premier niveau de `Machine`. `Machine.shippedAt` / `deliveredAt` restent (dates de la machine).
- `Machine.shipped_at` et `delivered_at` sont **conservées** : historique par machine, `Machine_shipped_at_check` (une machine `lost` a été expédiée) et source des dates de l'envoi.

### `PATCH /api/backoffice/machines/{machineId}`
Saisie directe : `{ "expectedUpdatedAt": "…", "serial": "S19-F-0001", "psuSerial": "…", "note": "…" }` (tous facultatifs sauf `expectedUpdatedAt` ; `null` efface). → `200 Machine` (fiche). Suivi de l'envoi de la facture de la machine (facultatif) : `carrier`, `trackingNumber`, `trackingUrl` (http/https, 500 car. au plus), voir « Envoi d'une facture » ; `409 shipment_no_order` sans facture payée. `404 machine_not_found`, `409 machine_modified`, `409 serial_taken` (`Machine_model_id_serial_key`), `409 machine_serial_frozen` (machine partie : `Machine_serial_frozen`), `409 machine_batch_frozen` (lot annulé), `400 invalid_input`.

### `POST /api/backoffice/batches/{batchId}/receptions`
Réception **en bloc** des machines attendues du lot (palette ou lot de stock), à tout statut sauf annulé. Au choix :
```json
{ "serials": ["S19-F-0001", "S19-F-0002"] }
{ "count": 10 }
{ "machineIds": ["uuid"], "serials": ["S19-F-0007"] }
```
- `serials` (collage d'une colonne, une ligne par machine ; lignes vides ignorées, doublons refusés) : autant de machines attendues que de numéros, **les plus anciennes d'abord**, numéros appariés dans l'ordre ;
- `count` : ce nombre de machines attendues, sans numéro (défaut : **toutes** les attendues) ;
- `machineIds` : ces machines (attendues, du lot), `serials` facultatif (même longueur).

Les machines passent `expected → in_stock` (non contrôlées). → `201 BatchMachines` (voir plus bas). Erreurs : `400 invalid_input`, `404 batch_not_found`, `409 reception_exceeds_expected` (`details: { "expected": 1 }` : plus de numéros que de machines attendues ; une machine en plus se déclare par `extra-machines`), `409 machine_not_expected` (machine choisie déjà reçue, manquante, transférée ou d'un autre lot), `409 serial_taken` (`details: { "serials": ["S19-F-0001"] }`, numéros déjà portés par une machine du modèle ; le message les cite ; aussi renvoyé par `PATCH …/machines/{id}` pour un `serial` déjà pris), `409 machine_batch_frozen` (lot annulé).

### `POST /api/backoffice/batches/{batchId}/extra-machines`
Machines reçues **en plus** de la palette `batchId` : créées au lot de stock du modèle (créé en pause s'il n'existe pas, « Créé par une machine reçue en plus du lot … »), origine la palette, et reçues aussitôt (à contrôler).
```json
{ "serials": ["S19-F-0011"], "note": "Dans le colis, non facturée" }
```
`serials` facultatif (sinon `count`, défaut 1) ; `note` écrite sur chaque machine. → `201 { "stockBatchId": "uuid", "machines": [Machine] }`. Erreurs : `404 batch_not_found`, `409 not_palette` (lot de stock), `409 palette_has_expected` (`details: { "expected": 2 }` : recevez ou marquez manquantes d'abord les machines attendues), `409 machine_origin` (palette avant l'Attente de réception : `Machine_origin`), `409 serial_taken`, `409 machine_batch_frozen` (palette annulée).

### `POST /api/backoffice/machines/status`
Changements de statut d'**une ou plusieurs** machines, tout ou rien (une ligne au journal par machine), avec dans la même transaction la saisie des hashboards :
```json
{ "items": [{
    "machineId": "uuid",
    "from": { "logistical": "in_stock", "functional": "unknown" },
    "to": { "functional": "degraded" },
    "hashboards": [{ "index": 1, "status": "dead" }],
    "note": "facultatif, obligatoire si noteRequired" }],
  "confirmRefunds": ["lineId"] }
```
- `from` (**obligatoire**) : statuts affichés ; `to` : au moins un des deux.
- `to.functional: "ok"` : les hashboards non envoyées sont saisies `ok` d'office (un clic « OK ») ; `degraded` / `faulty` : seules les hashboards envoyées sont écrites.
- `confirmRefunds` : ignoré (le marquage rembourse sans confirmation, voir « Machines en moins »).

Exemples : réception et contrôle d'un coup `{ "from": { "logistical": "expected", "functional": "unknown" }, "to": { "logistical": "in_stock", "functional": "ok" } }` ; « Marquer prêtes » 10 machines : 10 éléments `to: { "logistical": "ready" }` ; remise au transporteur avec suivi `"tracking": { "carrier": "DHL", "trackingNumber": "JD1", "trackingUrl": "https://…" }` (champs facultatifs, enregistrés sur l'envoi de la facture) ; machine perdue `{ "to": { "logistical": "lost" }, "note": "Colis perdu" }`.

→ `201 { "machines": [Machine], "refunds": [Refundable], "cancelledOrders": [{ "orderId", "cause": "admin" }] }`. Erreurs :
| Code | Cas (contrainte) |
|---|---|
| `400 invalid_input` | entrée invalide, machine listée deux fois |
| `404 machine_not_found` | |
| `409 machine_status_changed` | `from` ≠ statuts courants (`MachineStatusChange_current`) |
| `409 machine_transition_not_allowed` | couple absent de la table (`MachineStatusChange_allowed_check`), mise au rebut d'une machine non `faulty` (`Machine_scrapped_faulty_check`), préparation ou expédition d'une machine non contrôlée ou morte (`Machine_functional_before_prepare_check`) |
| `422 note_required` | (`MachineStatusChange_note_required_check`) |
| `422 machine_unchanged` | rien ne change (`MachineStatusChange_changed_check`) |
| `409 machine_batch_frozen` | lot annulé (`MachineStatusChange_batch_status`) |
| `409 machine_check_not_allowed` | contrôle d'une machine non reçue ou pas en main, ou retour à `unknown` (`MachineStatusChange_functional`, `HashboardStatus_machine_in_hand`) |
| `422 hashboards_inconsistent` | `ok` avec une hashboard non `ok`, ou hashboard morte sur une machine `ok` (`Machine_hashboards`) |
| `422 hashboard_index_out_of_range` | (`HashboardStatus_index_range`) |
| `409 shipment_incomplete` | remise au transporteur d'une machine dont la facture a une ligne active sans machine (`Shipment_complete`) ; `details.lines` : `[{ "lineId", "orderId", "position", "label": "Ligne 2 · Antminer S19" }]`, les lignes actives sans machine des factures des machines demandées (ordre facture, position) |
| `409 shipment_no_order` | suivi donné pour une machine sans facture payée (`Shipment_order_paid`, ou refus applicatif) |
| `409 machine_shipped_unassigned` | remise au transporteur d'une machine qui n'est la machine d'aucune ligne active de son lot (`Machine_shipped_assigned`) |
| `409 mounting_mismatch` | remise au transporteur d'une machine dont le montage n'est pas celui de sa ligne (`MachineStatusChange_mounting`) |
| `409 machine_shortage` / `machine_shortage_reserved` | voir « Machines en moins » (`Batch_stock`) ; pour `_reserved`, annuler les factures en attente : `POST /api/backoffice/orders/{orderId}/cancel` |
| `422 serial_required`, `422 degraded_acceptance_required`, `409 scrap_return_place_taken`, `422 refund_cause_unknown` | jalon 5 bis, voir « Machines » |

### `POST /api/backoffice/machines/{machineId}/scrap-return` (jalon 5 bis)
Annule la mise au rebut : retour « En stock » (la machine reste `faulty`, à recontrôler). Corps `{ "note": "motif obligatoire" }`. Le frontend affiche un **gros avertissement avant la mise au rebut** (`POST /machines/status` vers `scrapped`). → `201 { machines: [Machine], refunds: [] }`. Erreurs : `404 machine_not_found`, `409 machine_not_scrapped`, `422 note_required`, `409 scrap_return_place_taken` (`Machine_scrap_return_place` : lot survendu, la place a été reprise ; annuler ou rembourser une commande d'abord), `409 machine_status_changed`. `POST /machines/status` accepte aussi `scrapped → in_stock` (même règle ; `nextChanges` : action « Annuler la mise au rebut », `noteRequired: true`).

### `POST /api/backoffice/machines/check-ok`
« **Tout OK** » en bloc : pour chaque machine (en main), toutes les hashboards `ok` et l'état `ok`. Sert aussi au **recontrôle** d'une machine retournée ou retrouvée (déjà `ok` : hashboards ressaisies, elle redevient vendable).
```json
{ "machineIds": ["uuid", "uuid"], "note": "obligatoire pour corriger une machine dégradée ou défectueuse" }
```
→ `201 { "machines": [Machine] }`, tout ou rien. `404 machine_not_found`, `409 machine_check_not_allowed` (machine pas en main), `409 machine_batch_frozen`, `422 note_required`.

### `POST /api/backoffice/machines/import-checks`
**Import CSV du contrôle** : le technicien qui a contrôlé les machines hors de l'application importe l'état de leurs hashboards en bloc. Le fichier est du texte dans un corps JSON (l'API n'accepte que `application/json`).
```json
{ "modelId": "uuid", "csv": "name,serial,board1_statut,board2_statut,board3_statut\n1,SN1,ok,ok,ok\n2,SN2,ok,dead,ok", "dryRun": false, "confirmRefunds": ["lineId"] }
```
- **Format** : `name,serial,board1_statut,…,boardN_statut`. `N` doit être le `hashboardQtt` du modèle : sinon **tout le fichier est refusé**. Séparateur `,` (ou `;` si l'en-tête n'a pas de virgule), BOM et guillemets admis. Statuts : `ok`, `degraded`, `dead` (ou « dégradée », « morte ») ; cellule vide = hashboard non contrôlée (rien n'est écrit).
- **Correspondance** : par `serial` dans le modèle. `name` est le **numéro custom** de la machine (compteur par palette ou réassort, donc non unique par modèle) : il ne sert pas à la trouver mais de contrôle croisé, un écart avec la machine du `serial` refuse le fichier ; vide = non vérifié.
- **État fonctionnel déduit** : toutes les boards données `ok` → `ok` ; une board `degraded` ou `dead` → `degraded` (une machine `faulty` le reste ; la panne franche reste la décision du technicien) ; contrôle incomplet → inchangé. Motif au journal : « Import CSV du contrôle ». Mêmes règles que la saisie à la main (machines en moins : remboursements automatiques ou `409 machine_shortage`).
- `dryRun: true` → `200 { "dryRun": true, "items": [{ "line", "serial", "name", "from", "to", "boardsChanged" }], … }`, rien n'est écrit. Sinon `201 { "dryRun": false, "items", "machines", "refunds", "cancelledOrders" }`, tout ou rien.
- `422 csv_invalid` : `details.issues` (`line` : ligne du fichier, `null` pour l'en-tête ; 200 au plus) et `details.issueCount`. Fichier vide, mauvais nombre de boards, statut inconnu, série vide ou en double, série sans machine dans le modèle, `name` différent du numéro custom, machine pas en main. `404 model_not_found`.

### `PUT /api/backoffice/machines/{machineId}/hashboards`
Saisie ou correction de hashboards **une par une**, sans changer l'état fonctionnel : `{ "hashboards": [{ "index": 1, "status": "degraded" }] }` (seules les entrées envoyées sont écrites). → `200 Machine` (fiche). `404 machine_not_found`, `409 machine_check_not_allowed` (`HashboardStatus_machine_in_hand`), `422 hashboards_inconsistent` (hashboard non `ok` sur une machine `ok` : passer par `status`), `422 hashboard_index_out_of_range`.

### `GET /api/backoffice/batches/{batchId}/machines` (objet `BatchMachines`)
→ `200 { "summary": MachineSummary, "machines": [Machine], "lines": [MachineLine], "mountingPlan": [MountingPlanEntry], "canReceiveExtra": bool, "replacementAvailable": bool }` (`mountingPlan` : voir « Montage des machines à option » ; `replacementAvailable` : au moins une machine libre, en main et OK pour remplacer une ligne). `MachineLine.refundCause` : motif de remboursement de la ligne si sa machine est morte, perdue ou dégradée (`MachineRefundCause`), sinon `null`. `404 batch_not_found`. Machines dans l'ordre de création ; lignes payées actives premier payé d'abord. Les écritures `receptions`, `assignment`, `replacement` et `assignments/auto` renvoient le même objet (plus `refunds` ou `assigned`).

`MachineSummary` = la vue `batch_machine_summary` en camelCase (jalon 5 bis : `degraded` jamais confondue avec `ok`) : `kind`, `quantity` (`null` pour le stock), `capacity` (`batch_capacity`), `transferredOut`, `machines` (appartenant au lot aujourd'hui), `expected`, `received`, `inHand`, `unchecked`, `ok`, `degraded`, `faulty`, `missing`, `scrapped`, `lost`, `returned`, `inPreparation`, `inTransit`, `delivered`, `unsold` (partiraient au stock à la clôture), `writtenOff`, `unusable`, `paidLines`, `assignedLines`, `unassignedLines`, `undeliveredLines`, `linesToReplace`, `linesToRemount` (parmi `linesToReplace`, montage non conforme seul), `degradedLines`, `freeMachines`, `freeOkMachines`, `sellableMachines` (« disponibles » du lot de stock), `toRecheck`, `surplusLines`, `okLines`, `unsoldDegraded`.

Compteurs du lot (`Batch.counters`, jalon 5 bis) : `okMachines`, `degradedMachines`, `machinesToStockDegraded` (invendues dégradées), `okLines`, `degradedLines`. Les `facts` de transition portent `expectedMachines`, `surplusLines`, `linesToReplace`, `linesToRemount`, `unassignedLines` : `transitions[].blockers` du lot affiche déjà les quatre blocages de sortie du Contrôle.

`MachineLine` : `{ "lineId", "orderId", "position", "paidAt", "customer": { "authUserId", "contactEmail" }, "amount": "50000", "configuration": [{ "option": "Kit de ventilation", "value": "Silent kit" }], "machineId": "uuid" | null, "machineSerial": "…" | null, "canAssign": false, "canReplace": true, "canRemove": true, "problem": null | "faulty" | "lost" | "degraded", "surplusRank": null | 2, "degradedAcceptedAt": null | "…" }` (`problem` : machine à remplacer, ou attribuée dégradée ; `surplusRank` : rang de conservation dans `batch_surplus_lines` (la ligne en trop de rang le plus haut est remboursée la première), `null` si la ligne n'est pas en trop). R4b : `canAssign` (ligne sans machine, palette du Contrôle à En transit ou lot de stock), `canReplace` / `canRemove` (machine pas encore remise au transporteur ni livrée, lot non annulé) : ne proposer que les actions possibles. `BatchMachines` porte aussi `canReceiveExtra` : « Machine en plus » utile seulement sur une palette pleine (aucune machine attendue).

### `POST /api/backoffice/order-lines/{lineId}/assignment`
Attribuer, remplacer ou retirer la machine d'une ligne payée :
```json
{ "expectedMachineId": null, "machineId": "uuid" | null, "reason": "facultatif ; obligatoire pour un remplacement, un retrait ou une machine dégradée", "confirmRefunds": ["lineId"] }
```
`expectedMachineId` (**obligatoire**, `null` si aucune) : machine affichée pour cette ligne ; sinon `409 assignment_changed`.
**Machine `degraded` (jalon 5 bis)** : motif **et** `"customerAcceptsDegraded": true` (le client a explicitement accepté la machine : la base enregistre le client de la ligne et l'instant ; `MachineLine.degradedAcceptedAt`). Sans acceptation : `422 degraded_acceptance_required`. Sans effet pour une machine `ok`. L'UI demande la confirmation du client avant d'envoyer `true`.
→ `201 BatchMachines` + `refunds`. Erreurs : `404 line_not_found`, `409 assignment_changed`, `409 line_not_active` (`OrderLineAssignment_active_line`), `409 assignment_batch_status` (palette avant le Contrôle ou terminée), `422 reason_required` (`OrderLineAssignment_reason`, `OrderLineAssignment_degraded_reason`), `422 degraded_acceptance_required` (`OrderLineAssignment_degraded_acceptance`), `409 machine_not_assignable` (`OrderLineAssignment_machine_assignable`, machine d'un autre lot : `OrderLineAssignment_machine_in_batch`), `409 mounting_mismatch` (`OrderLineAssignment_mounting` : montage différent de celui de la ligne, ou machine pas prête pour une ligne à kit), `409 machine_already_assigned` (`OrderLine_machine_id_active_key`), `409 machine_shipped` (`OrderLineAssignment_shipped`), `422 machine_unchanged` (`OrderLineAssignment_changed`), `409 machine_shortage` (remplacement qui prend la dernière machine vendable d'un lot de stock plein).

### `POST /api/backoffice/order-lines/{lineId}/replacement`
**Remplacer en un clic** la machine d'une ligne (morte, perdue, ou autre) : `{ "expectedMachineId": "uuid", "reason": "Machine morte", "confirmRefunds": ["lineId"] }` (`reason` obligatoire).
- Le serveur choisit la meilleure machine libre `ok` du lot (prêtes d'abord ; jamais une `degraded`, à attribuer à la main avec motif).
- Aucune : la machine est retirée de la ligne ; si le lot manque alors de machines, `409 machine_shortage` annonce la commande payée la plus récente ; avec la confirmation, elle est remboursée et sa machine (en main, `ok`) est donnée à cette ligne ; si la ligne en trop est celle-ci, elle est simplement remboursée. S'il reste des places (machines encore attendues), la ligne reste sans machine jusqu'à la prochaine attribution.
→ `201 BatchMachines` + `refunds`. Mêmes erreurs que `assignment`.

### `POST /api/backoffice/batches/{batchId}/assignments/auto`
**Attribution automatique** (corps `{}`) : chaque ligne payée sans machine reçoit une machine libre `ok` du lot, **premier payé d'abord**, machines prêtes d'abord ; lot de stock : machines vendables seulement ; jamais une machine `degraded` ni non contrôlée. Lignes verrouillées d'abord : deux attributions simultanées n'attribuent jamais deux fois. → `201 BatchMachines` + `"assigned": 2`. `404 batch_not_found`, `409 assignment_batch_status` (palette avant le Contrôle ou terminée). Remplace l'ancienne suggestion `assignments/suggest` (moins de clics : l'admin corrige ensuite ligne par ligne).

### `GET /api/backoffice/stock`
**Stock par modèle** (vue `model_stock_summary`), une ligne par modèle qui a un lot de stock ou des machines, modèles par nom :
```json
{ "items": [{ "model": { "id": "uuid", "name": "S19" },
  "stockBatch": { "id": "uuid", "name": "Stock S19", "status": "on_sale", "statusLabel": "En vente" } | null,
  "expected": 1, "toCheck": 2, "sellable": 3, "available": 2, "reserved": 1, "assigned": 1, "assignedDegraded": 0, "degraded": 1, "faulty": 0, "inPalettes": 4, "inPalettesDegraded": 1 }] }
```
Colonnes du lot de stock : `expected` (à recevoir), `toCheck` (à contrôler ou recontrôler), `sellable` (vendables libres), `available` (`batch_available_stock` : ni vendues ni réservées), `reserved` (= `sellable` − `available` : retenues par une commande payée sans machine ou une facture en attente), `assigned` (en main, attribuées : à expédier), `degraded` (en main, libres : jamais vendables depuis le stock), `faulty` (en main : à mettre au rebut) ; `inPalettes` : invendues des palettes non annulées du modèle (à transférer). Jalon 5 bis : `assignedDegraded` (parmi `assigned`), `inPalettesDegraded` (parmi `inPalettes`) ; `degraded` n'entre jamais dans `sellable` ni `available`.

### Conditions de transition du lot
`BatchFacts` lit ses compteurs de machines et de lignes payées dans `batch_machine_summary` (source unique ; colonnes `in_preparation`, `undelivered_lines` et `unsold` ajoutées). Blocages existants inchangés ; blocages **proposés** (à confirmer par Hugo, question 8 du jalon 5) : Contrôle → Tuning / Packaging bloqué si `expected > 0`, `linesToReplace > 0`, `surplusLines > 0` ; Contrôle → Packaging bloqué si `unassignedLines > 0`.

### Côté client
Aucune route : le suivi est lu dans `shipment` des factures du client (`GET /api/orders`, R6 lot 2) ; l'affichage relève de R6 lot 3. Question ouverte : afficher « machine attribuée » sur la ligne de la facture.

### Exemple de parcours (palette de 3, 2 vendues)
1. `POST /batches/{id}/transitions` `ordering → awaiting_reception` : 3 machines attendues.
2. `POST /batches/{id}/receptions` `{ "serials": ["F-1", "F-2", "F-3"] }` ; `POST …/transitions` `→ inspection`.
3. `POST /machines/check-ok` `{ "machineIds": [m1, m2, m3] }` (ou une machine dégradée via `status`).
4. `POST /batches/{id}/assignments/auto` `{}` → 2 lignes servies, premier payé d'abord ; `POST …/transitions` `→ packaging`.
5. `POST /machines/status` `ready`, puis `in_transit` ; `→ in_transit` (lot) ; `delivered`.
6. `POST …/transitions` `→ closed` : l'invendu part au lot de stock du modèle.

---

## Lot de stock : réassort et transfert (refonte R2b)

Whitelist. Code : `src/server/batches.ts` (`restockBatch`, `listRestocks`, `transferToStock`), routes `src/app/api/backoffice/batches/[batchId]/restocks`, `…/transfers`. Deux journaux en ajout seul (`StockRestock`, `MachineTransfer`) ; les règles sont celles de la base (seule source), le serveur traduit ses refus.

### Objet `Restock`
```json
{ "id": "uuid", "quantity": 3, "purchasePrice": "270000", "note": "Fournisseur Shenzhen, facture 42" | null,
  "machines": 3, "createdBy": "1", "createdAt": "…" }
```
`purchasePrice` : prix d'achat **total** du réassort, centimes. `machines` : machines créées par le réassort (= `quantity`).

### `POST /api/backoffice/batches/{batchId}/restocks`
Réassort du lot de stock `batchId` (en vente ou en pause) :
```json
{ "quantity": 3, "purchasePrice": "270000", "note": "Fournisseur Shenzhen, facture 42" }
```
`quantity` : 1 à 10 000 ; `purchasePrice` : `"0"` à `"10000000000"` centimes (prix total ; `"0"` admis : machine reprise, don) ; `note` facultative (500 caractères). La base crée `quantity` machines **attendues** (`expected`) dans le lot : elles comptent dans `counters.expectedMachines`, puis deviennent vendables (`capacity`, `availableStock`) une fois **reçues et contrôlées** `ok`, toutes hashboards `ok` (`POST …/receptions`, puis `POST /machines/check-ok`). Change `updatedAt` du lot.
→ `201 Batch` (le lot de stock, avec `restocks`). Erreurs : `400 invalid_input`, `404 batch_not_found`, `409 not_stock_batch` (palette : « Seul un lot de stock se réassortit : une palette reçoit les machines de sa quantité. »).

### `GET /api/backoffice/batches/{batchId}/restocks`
→ `200 { "items": [Restock] }`, du plus ancien au plus récent (`[]` pour une palette). `404 batch_not_found`. (Même liste que `Batch.restocks`.)

### `POST /api/backoffice/batches/{batchId}/transfers`
Transfère des machines de la **palette** `batchId` vers le lot de stock de son modèle (motif `admin`), à tout statut de la palette sauf annulée : invendus avant la clôture, machine retournée après. Le lot de stock est **créé en pause** (« Stock {modèle} », journal : « Créé par un transfert depuis le lot … ») s'il n'existe pas encore (règle unique en base, `stock_batch_of`, partagée avec la clôture).
```json
{ "machineIds": ["uuid", "uuid"], "note": "Invendus, palette bientôt close" }
```
`machineIds` : 1 à 10 000 identifiants distincts ; `note` facultative (500 caractères). Tout ou rien, en une transaction (machines verrouillées par id, puis les deux lots). Une machine transférée garde son origine (`originBatchId`) ; elle n'est vendable depuis le stock qu'en main, `ok` et contrôlée (une machine non contrôlée ou `degraded` y arrive, mais n'y est pas vendable). Change `updatedAt` des deux lots.
→ `201 Batch` (la palette, avec `transfers` et `counters.transferredOut`). Erreurs :

| Code | Cas (contrainte de la base) |
|---|---|
| `400 invalid_input` | liste vide, doublon, identifiant mal formé |
| `404 batch_not_found` | |
| `409 transfer_from_stock` | `batchId` est un lot de stock (`MachineTransfer_direction`) |
| `409 machine_not_in_batch` | une machine inconnue, d'un autre lot, ou déjà transférée (`MachineTransfer_current`) : recharger |
| `409 machine_assigned` | machine d'une ligne de commande non remboursée : la retirer d'abord de la commande (`MachineTransfer_assigned`) |
| `409 machine_not_in_hand` | machine attendue, manquante, perdue, expédiée, livrée ou au rebut : seule une machine en main ou retournée se transfère (`MachineTransfer_machine_in_hand`) |
| `409 machine_batch_frozen` | palette annulée (`Machine_batch_frozen`) |
| `409 transfer_exceeds_capacity` | la palette n'aurait plus de quoi servir ses commandes payées ou réservées (`Batch_stock` au COMMIT) ; `details: { "orderedMachines": 1, "capacity": 2 }` |

Exemple de parcours (palette de 3 machines, 1 vendue, fin de vie) :
1. `POST /batches/{palette}/transfers` `{ "machineIds": [m2, m3] }` → palette `counters.capacity` 1, `transferredOut` 2 ; lot « Stock S19 » créé en pause, `sellableMachines` 2.
2. `POST /batches/{stock}/transitions` `{ "from": "draft", "to": "on_sale" }` → le stock est en vente, visible en boutique « En stock », 2 disponibles.
3. Plus tard : `POST /batches/{stock}/restocks` `{ "quantity": 4, "purchasePrice": "360000" }` → 4 machines attendues à recevoir et contrôler.

---

## Stock des produits d'options

Un produit d'option (`Part`, ex. Silent kit) est un produit physique acheté tel quel, partagé par les valeurs d'option de plusieurs modèles. Son stock est **commun à tous les lots** : stock physique = somme d'un journal de mouvements (jamais modifié, jamais négatif). Tout est calculé à la lecture (vues SQL), rien n'est stocké.

### Objet `PartStock` (stock et pression d'un produit)
```json
{
  "partId": "uuid", "name": "Kit silencieux", "reference": "SK-01",
  "onHand": 10, "orderingQty": 4, "awaitingDeliveryQty": 0,
  "firmDemand": 16, "potentialDemand": 1,
  "pressure": "1.600", "overPressure": true, "shortfall": 6, "toOrder": 2
}
```
| Champ | Sens |
|---|---|
| `onHand` | stock physique (somme du journal) |
| `orderingQty`, `awaitingDeliveryQty` | kits commandés (« Commande en cours ») et en route (« Attente de livraison »), toutes commandes de lot confondues |
| `firmDemand` | demande ferme des lots qui n'ont pas encore consommé leurs kits : machines payées + factures en attente non expirées, moins les kits déjà montés |
| `potentialDemand` | manifestations d'intérêt des lots au sondage, **affichée à part, hors pression** |
| `pressure` | `firmDemand ÷ onHand`, décimal en chaîne à 3 décimales (`"1.600"`) ; `"0"` sans demande ; `null` = demande sans aucun stock (pression infinie) |
| `overPressure` | avertissement : pression > 1 |
| `shortfall` | manque par rapport au stock physique (`max(firmDemand − onHand, 0)`) |
| `toOrder` | manque une fois comptés les kits commandés et en route |

### `GET /api/backoffice/part-stock`
Vue d'ensemble des produits d'options. → `200 { "items": [PartStock] }` (tri par nom).

### `GET /api/backoffice/batches/{batchId}/part-needs`
Fiche lot : besoin du lot par produit, avec le stock commun et la pression globale du produit, et les commandes de produits du lot.
```json
{
  "batchId": "uuid",
  "parts": [{
    "partId": "uuid", "name": "Kit silencieux", "reference": "SK-01",
    "firmQty": 8, "potentialQty": 0, "mountedQty": 0, "remainingQty": 8,
    "orderedQty": 4, "deliveredQty": 0,
    "stock": PartStock
  }],
  "orders": [PartOrder]
}
```
`firmQty` : demande ferme du lot ; `potentialQty` : manifestations d'intérêt (lot au sondage) ; `mountedQty` : kits déjà montés sur ce lot ; `remainingQty` : demande ferme restant à prélever sur le stock commun (0 pour un lot clôturé ou annulé) ; `orderedQty` / `deliveredQty` : kits commandés pour ce lot et non livrés / kits effectivement reçus (somme des réceptions, pas la quantité commandée : 3 reçus sur 6 commandés donnent `deliveredQty: 3`). Un produit apparaît dès qu'il a une demande, un kit monté ou une commande sur ce lot. Un menu masqué n'a pas de demande (son défaut n'a rien à acheter).
→ `200`. `404 batch_not_found`.

### Journal de stock d'un produit
**Mouvement** :
```json
{ "id": "uuid", "partId": "uuid", "kind": "kit_mounted", "kindLabel": "Kit monté", "qty": -3,
  "batchPartOrderId": null, "batch": { "id": "uuid", "name": "10 S19" }, "machineId": null,
  "note": null, "createdBy": "1", "createdAt": "…" }
```
`kind` : `reception` (Réception), `adjustment` (Correction d'inventaire), `kit_mounted` (Kit monté). `qty` signé : entrée > 0, sortie < 0.

- `GET /api/backoffice/parts/{partId}/movements` → `200 { "stock": PartStock, "items": [Mouvement] }` (200 derniers, du plus récent au plus ancien). `404 part_not_found`.
- `POST /api/backoffice/parts/{partId}/movements`, selon `kind` :
  - réception hors commande de lot (réassort) : `{ "kind": "reception", "quantity": 10, "note"?: "…" }` ;
  - correction d'inventaire : `{ "kind": "adjustment", "quantity": -2, "note": "Casse" }` (`quantity` signée, non nulle ; motif obligatoire) ;
  - kit monté sur une machine d'un lot : `{ "kind": "kit_mounted", "quantity": 3, "batchId": "uuid", "machineId"?: "uuid", "note"?: "…" }` (`quantity` positive, enregistrée en sortie).

  `quantity` : 1 à 100 000 (correction : −100 000 à 100 000). La réception d'une commande de lot passe par la livraison de la commande (ci-dessous).
  → `201 { "movement": Mouvement, "stock": PartStock }`. `400 invalid_input`, `404 part_not_found`, `409 part_stock_insufficient` (le stock deviendrait négatif ; sûr en concurrence), `422 part_not_for_model` (kit monté : le produit n'équipe aucune option du modèle du lot), `422 unknown_batch`, `422 unknown_machine` (machine hors du lot).

### Commandes de produits d'un lot
**PartOrder** :
```json
{ "id": "uuid", "batchId": "uuid", "partId": "uuid", "partName": "Kit silencieux", "qty": 8,
  "status": "awaiting_delivery", "statusLabel": "Attente de livraison",
  "orderedAt": "…", "deliveredAt": null, "receivedQty": null }
```
Statuts : `ordering` (Commande en cours) → `awaiting_delivery` (Attente de livraison) → `delivered` (Livré) ; `ordering` → `delivered` permis ; jamais en arrière. Une commande par produit et par lot.

- `POST /api/backoffice/batches/{batchId}/part-orders` `{ "partId": "uuid", "qty": 8 }` → `201 PartOrder`. `404 batch_not_found`, `409 part_order_exists`, `409 batch_finished` (lot clôturé ou annulé), `422 unknown_part`.
- `PATCH /api/backoffice/part-orders/{orderId}` `{ "status"?: "awaiting_delivery" | "delivered", "qty"?: 9, "receivedQty"?: 7, "note"?: "…" }` → `200 PartOrder`.
  - **Livraison** (`status: "delivered"`) : statut, date de livraison et réception au stock commun (`receivedQty` kits, par défaut la quantité commandée ; `note` jointe) dans **une seule transaction**, sous verrou de la commande. Une seule réception par commande ; deux livraisons simultanées n'en enregistrent qu'une. Rejouer la livraison à l'identique (`receivedQty` absent ou égal à la quantité reçue) répond `200` sans rien changer (la `note` d'un rejeu est ignorée). Avec une autre `receivedQty` : `409 part_order_already_delivered`, rien n'est écrit, message « Cette commande est déjà livrée avec 3 kit(s) reçu(s) : la quantité reçue ne change plus. Pour corriger le stock, enregistrez une correction d'inventaire sur le produit. » (correction : `POST /parts/{partId}/movements` `kind: "adjustment"`).
  - `receivedQty` et `note` ne s'envoient qu'avec `status: "delivered"` (sinon `400 invalid_input`). `qty` : modifiable tant que la commande n'est pas livrée.
  - Erreurs : `404 part_order_not_found`, `409 part_order_status_invalid` (retour arrière), `409 part_order_frozen` (quantité d'une commande livrée), `409 part_order_already_delivered` (livraison rejouée avec une autre quantité reçue).

### Exemple de parcours

```http
POST /api/backoffice/models
{ "name": "S19", "hashrate": "95000000000000", "hashboardQtt": 3 }
→ 201 { "id": "m1", … }

POST /api/backoffice/models/m1/options
{ "kind": "choice", "title": "Kit de ventilation", "values": [
  { "label": "Sans kit", "price": "0" }, { "label": "Air Flow", "price": "3500" }, { "label": "Silent kit", "price": "7500" } ] }
→ 201 { "id": "o1", "values": [{ "id": "v0", "isDefault": true, … }, …] }

POST /api/backoffice/batches
{ "modelId": "m1", "quantity": 10, "purchasePrice": "1500000", "resaleUnitPrice": "180000" }
→ 201 { "id": "b1", "name": "10 S19", "status": "draft", "transitions": [{ "to": "survey", "allowed": true, … }, …] }

POST /api/backoffice/batches/b1/transitions
{ "to": "survey", "from": "draft" }
→ 201 { "status": "survey", … }
```

---

## Boutique publique (jalon 3)

Sans connexion. Lots visibles : palette au **Sondage, puis de la Précommande au Packaging**, et **lot de stock en vente** (fonction SQL `batch_is_public`, source unique avec la base : un lot en transit, clôturé, annulé, ou un lot de stock en pause n'est plus public). Un lot en brouillon, à un autre statut ou inconnu donne `404 batch_not_found`, comme un identifiant mal formé. Jamais exposés : prix d'achat, quantité achetée, compteurs, réglages internes (dérogations en tant que telles, valeurs retirées, menus masqués), journal.

### Objet `PublicBatch`
```json
{
  "id": "uuid", "name": "10 S19", "kind": "wholesale", "status": "survey", "statusLabel": "Sondage",
  "model": { "id": "uuid", "name": "S19", "hashrate": "95000000000000", "description": "Antminer S19 95 TH/s" },
  "availableQuantity": 10,
  "resaleUnitPrice": "180000",
  "acceptsOrders": false,
  "priorityEndsAt": null
}
```
`acceptsOrders` : le lot accepte des factures (Précommande à Packaging, lot de stock en vente ; fonction SQL `batch_accepts_orders`). `priorityEndsAt` : fin de la journée de priorité (réservée aux personnes ayant manifesté leur intérêt, dans la limite de leurs machines souhaitées), `null` s'il n'y en a pas ; peut être passée (comparer à l'heure courante). `name` : nom du lot, **toujours renseigné** (colonne obligatoire) : le nom choisi par l'admin, sinon le nom par défaut « {quantité} {modèle} » posé à la création et tenu à jour tant qu'il n'est pas personnalisé. `availableQuantity` : machines encore disponibles (`batch_available_stock`, jamais négatif à l'affichage ; au sondage = quantité du lot). `resaleUnitPrice` : prix de la machine nue, centimes.

**Lot de stock** (`kind: "stock"`) : `status: "on_sale"`, `statusLabel: "En stock"`, `acceptsOrders: true`, `priorityEndsAt: null` (jamais de priorité), `availableQuantity` = machines vendables (en main, `ok`, contrôlées) moins les machines payées ou réservées ; `wishlistLimit: 0` (pas de manifestation d'intérêt : `POST /api/wishlists` répond `409 wishlist_closed`, « Ce lot est en stock : il se commande directement, sans manifestation d'intérêt. »). Il se commande comme une palette ouverte (`POST /api/orders`), facture de nature `order` (« Commande »). Exemple :
```json
{ "id": "uuid", "name": "Stock S19", "kind": "stock", "status": "on_sale", "statusLabel": "En stock",
  "model": { "…": "…" }, "availableQuantity": 3, "resaleUnitPrice": "52000", "acceptsOrders": true, "priorityEndsAt": null }
```

### `GET /api/shop/batches`
→ `200 { "items": [PublicBatch] }`, du plus récent au plus ancien.

### `GET /api/shop/batches/{batchId}`
Fiche produit : `PublicBatch` plus les options proposées par le lot.
```json
{
  "…": "champs de PublicBatch",
  "wishlistLimit": 5,
  "maxMachinesPerOrder": 10,
  "stockOffer": { "batchId": "uuid", "name": "Stock S19", "availableQuantity": 3 },
  "options": [{
    "id": "uuid", "kind": "choice", "title": "Kit de ventilation", "description": null, "position": 0,
    "values": [
      { "id": "uuid", "label": "Sans kit", "isDefault": true, "position": 0, "price": "0", "maxQty": null },
      { "id": "uuid", "label": "Silent kit", "isDefault": false, "position": 1, "price": "6000", "maxQty": 3 }
    ]
  }]
}
```
`wishlistLimit` : plafond effectif de manifestations d'intérêt actives **par utilisateur** sur ce lot (le même pour tous) : réglage `ShopSettings.wishlist_max_per_user_per_batch` (défaut 5, imposé par la base), jamais plus que la quantité du lot ; `0` pour un lot de stock. `maxMachinesPerOrder` : machines au plus par facture (`ShopSettings.order_max_lines`, défaut 10) (voir `POST /api/wishlists`). Pour afficher ce qui reste à un utilisateur connecté : `wishlistLimit` − nombre de ses wishlists du lot (`GET /api/wishlists?batchId=…`).

`stockOffer` : lot de stock public et en vente du **même modèle** ayant au moins une machine vendable, sinon `null` (toujours `null` sur un lot de stock). La fiche d'un lot épuisé s'en sert pour renvoyer vers le stock (« Disponible en stock »).

`options` (objet `OfferedMenu`) : menus **visibles** du lot (un menu masqué n'apparaît pas : son défaut s'applique d'office), triés par `position` puis `title` ; `values` : valeurs **proposées** (une valeur retirée du lot n'apparaît pas), triées par `position` puis `label`. `price` : prix effectif sur le lot (dérogation, sinon catalogue), `"0"` pour le défaut. `maxQty` : nombre maximal de machines vendues avec cette valeur (`null` = illimité ; information, ne limite pas les manifestations d'intérêt). La valeur `isDefault` est présélectionnée.
→ `200`. `404 batch_not_found`.

---

## Manifestations d'intérêt (wishlists, jalon 3)

Utilisateur connecté (cookie `access_token` d'auth-service), sans argent. L'utilisateur local (`User`) est créé à la première requête authentifiée. **Une wishlist = une machine souhaitée**, avec sa propre configuration : pour plusieurs machines d'un même lot, plusieurs wishlists (éventuellement de configurations différentes). Chacun ne voit, ne modifie et ne retire que les siennes : la wishlist d'un autre répond `404 wishlist_not_found`, comme une wishlist inconnue ou retirée.

**Configuration** : la requête n'envoie que des choix `{ optionId, optionValueId }` ; un menu visible non choisi reçoit sa valeur par défaut (0 €). Les prix ne viennent jamais du client : ils sont relus en base (prix de revente du lot, prix effectif des options) et figés dans la configuration (instantané). Une modification prend un nouvel instantané (prix de revente et options relus au moment de la modification).

**Configuration figée dès la précommande** (décision Hugo 2026-10-07) : la configuration ne se modifie **que pendant le sondage**. Dès que le lot passe en Précommande (et à tout statut suivant), elle est immuable ; le **retrait** reste possible à tout moment, sauf pour une wishlist convertie en commande payée (voir `DELETE`). Garanti aussi en base (triggers `*_wishlist_frozen`, contrainte `Wishlist_configuration_frozen` → `409 wishlist_not_editable`), sûr en concurrence : une modification validée avant l'ouverture des précommandes reste, une modification qui arrive après est refusée. Lot dépublié (brouillon) : modification suspendue jusqu'à la republication. Un menu masqué par l'admin pendant le sondage ramène les choix des wishlists à la valeur par défaut (inchangé).

### Objet `Wishlist`
```json
{
  "id": "uuid", "createdAt": "2026-10-07T10:00:00.000Z", "updatedAt": "2026-10-07T11:00:00.000Z",
  "batch": { "id": "uuid", "name": "Palette Bitmain", "status": "survey", "statusLabel": "Sondage",
             "isPublic": true, "acceptsOrders": false, "priorityEndsAt": null, "model": { "id": "uuid", "name": "S19" } },
  "basePrice": "180000",
  "items": [
    { "optionId": "uuid", "optionTitle": "Kit de ventilation", "optionValueId": "uuid", "label": "Silent kit", "isDefault": false, "unitPrice": "6000", "offered": true },
    { "optionId": "uuid", "optionTitle": "Nettoyage", "optionValueId": "uuid", "label": "Sans", "isDefault": true, "unitPrice": "0", "offered": true }
  ],
  "amount": "186000",
  "resaleUnitPrice": "190000",
  "converted": false,
  "orderId": null,
  "editable": true,
  "outdated": false,
  "optionWithdrawals": [
    { "optionId": "uuid", "optionTitle": "Kit de ventilation", "withdrawnValueId": "uuid", "withdrawnValueLabel": "Air Flow",
      "withdrawnUnitPrice": "3500", "defaultValueId": "uuid", "defaultValueLabel": "Sans kit", "createdAt": "…" }
  ]
}
```
| Champ | Sens |
|---|---|
| `updatedAt` | dernière modification de la configuration (« modifiée le »), tenue par la base |
| `batch.name` | nom du lot, toujours renseigné (nom choisi par l'admin, sinon « {quantité} {modèle} ») ; nom actuel, pas un instantané |
| `batch.isPublic` | fiche du lot visible du public (lien « Voir le lot ») |
| `batch.acceptsOrders` | le lot accepte des commandes (Précommande à Packaging, fonction SQL `batch_accepts_orders`) : « Commander » reprend les machines souhaitées non commandées |
| `batch.priorityEndsAt` | fin de la journée de priorité du lot, `null` s'il n'y en a pas. Retirer la wishlist avant cette date fait perdre la priorité pour cette machine : à annoncer dans le dialogue de retrait |
| `basePrice` | prix de revente de la machine nue au moment de la configuration |
| `items` | un item par menu visible du lot, défaut compris (« Sans », 0 €) ; aucun pour un menu masqué ; triés comme les menus |
| `amount` | prix indicatif de la machine configurée (`basePrice` + options), aucun paiement |
| `resaleUnitPrice` | prix de revente **actuel** du lot (machine nue, centimes), seulement si `editable` ; `null` sinon (configuration figée : le prix actuel du lot ne la concerne plus). Peut différer de `basePrice` si l'admin a changé le prix pendant le sondage : à afficher comme avertissement, l'instantané (`basePrice`, `amount`) reste la référence de la wishlist |
| `items[].offered` | le lot propose encore cette valeur (`batch_offered_values`). Depuis la v5j, un retrait ramène tout de suite la wishlist au défaut : `false` ne se voit plus que sur des données antérieures (prix affiché plus d'actualité, commande refusée `422 option_not_offered`) |
| `outdated` | au moins un `items[].offered` est faux (données antérieures à la v5j) : à signaler à l'utilisateur |
| `optionWithdrawals` | options retirées du lot après avoir été choisies (sondage compris), du plus ancien au plus récent (journal `WishlistOptionWithdrawal`, écrit par la base) : la configuration est revenue au défaut du menu (`defaultValueLabel`, 0 €), la wishlist et sa priorité restent. `withdrawnUnitPrice` : prix figé de la valeur retirée (centimes). À annoncer : « L'option « Air Flow » (35 €) a été retirée de ce lot : votre intérêt est conservé avec « Sans kit » ». `[]` : rien |
| `converted` | devenue une commande payée (ligne non remboursée d'une facture payée, jalon 4) : ni modifiable ni retirable |
| `orderId` | facture payée qui a converti la machine (lien « Voir la commande », où se fait le renoncement) ; `null` si non convertie |
| `editable` | configuration modifiable : lot **au sondage** et wishlist non convertie. Faux à tout autre statut (brouillon : lot dépublié ; Précommande et suivants : configuration figée ; clôturé, annulé) |

`batch.status` peut être n'importe quel statut (le lot a pu avancer, être dépublié ou annulé depuis) : l'afficher avec `statusLabel`.

### `GET /api/wishlists`
Paramètre facultatif `batchId` (uuid). → `200 { "items": [Wishlist] }` : wishlists actives (non retirées) de l'utilisateur, de la plus récente à la plus ancienne. `400 invalid_input` (`batchId` mal formé), `401 unauthenticated`.

### `POST /api/wishlists`
```json
{ "batchId": "uuid", "choices": [{ "optionId": "uuid", "optionValueId": "uuid" }], "quantity": 2 }
```
`choices` facultatif (`[]` : tous les défauts) ; `quantity` facultatif, 1 à 10 000 (défaut 1 ; au-delà du plafond par personne, c'est `409 wishlist_limit_reached` qui répond, avec le vrai plafond) : crée `quantity` wishlists de même configuration, en une transaction (tout ou rien). Champs inconnus (`amount`, `unitPrice`…) : `400 invalid_input`.
→ `201 { "items": [Wishlist] }` (les wishlists créées).

Plafond : au plus **N wishlists actives par utilisateur et par lot**, N = `ShopSettings.wishlist_max_per_user_per_batch` (table de réglages, défaut 5, imposé aussi par la base : `Wishlist_cap`), et jamais plus que la quantité du lot. Compté sous verrou de l'utilisateur : deux requêtes simultanées ne le dépassent pas. Une wishlist retirée libère sa place.

| Code | Cas |
|---|---|
| `400 invalid_input` | entrée invalide ; même menu choisi deux fois |
| `401 unauthenticated` | |
| `404 batch_not_found` | lot inconnu ou en brouillon |
| `409 wishlist_closed` | lot hors sondage (« Les manifestations d'intérêt ne sont ouvertes que pendant le sondage du lot. ») |
| `409 wishlist_limit_reached` | plafond atteint ; le message dit combien de machines restent possibles (« Vous en demandez 3, mais il ne vous reste que 2 machines sur ce lot (maximum 5 par personne). ») |
| `422 option_not_offered` | menu masqué, absent du lot, ou valeur retirée / d'un autre menu ; le message nomme ce qui a disparu (« L'option « Silent kit : Avec » n'est plus proposée sur ce lot. »), sans prix ; message générique si les identifiants sont inconnus |

### `GET /api/wishlists/{wishlistId}`
→ `200 Wishlist` plus l'offre **actuelle** du lot, pour le formulaire de modification : `options`, ce que le lot propose (même format que `options` de la fiche produit publique), `null` si `editable` est faux. Le total indicatif d'une nouvelle configuration se calcule sur `resaleUnitPrice` (champ de l'objet `Wishlist`) + prix des options choisies.

```json
{ "…": "champs de Wishlist", "options": [OfferedMenu] }
```
`options` n'existe que sur cette route et sur la réponse de `PATCH` (pas dans `GET /api/wishlists` ni `POST`). `404 wishlist_not_found`.

### `PATCH /api/wishlists/{wishlistId}`
```json
{ "choices": [{ "optionId": "uuid", "optionValueId": "uuid" }] }
```
Remplace la configuration (liste complète des choix ; un menu absent revient à son défaut). **Pendant le sondage seulement** (`editable`).
→ `200 Wishlist` (avec `options`). `400 invalid_input`, `404 wishlist_not_found`, `409 wishlist_converted`, `422 option_not_offered`, `409 wishlist_not_editable` (lot hors sondage), avec un message selon le cas :
- Précommande et suivants : « Le sondage de ce lot est terminé (statut « Précommande ») : la configuration de votre manifestation d'intérêt ne se modifie plus. Vous pouvez encore la retirer. » ;
- brouillon : « Ce lot n'est plus publié : la configuration ne peut pas être modifiée pour l'instant. » ;
- clôturé / annulé : « Ce lot est clôturé : la configuration ne se modifie plus. » (resp. « annulé »).

### `DELETE /api/wishlists/{wishlistId}`
Retire la manifestation d'intérêt, à tout statut du lot (y compris après le sondage, quand la configuration est figée), **sauf si elle est convertie** (`converted: true`). Idempotent : une wishlist déjà retirée répond aussi `204`.

Contrôles, dans cet ordre :
1. wishlist inconnue ou d'un autre utilisateur : `404 wishlist_not_found` (même pour une wishlist convertie d'un autre) ;
2. déjà retirée : `204`, sans effet ;
3. convertie en commande payée : `409 wishlist_converted`, rien n'est écrit, message « Cette manifestation d'intérêt est devenue une commande payée : elle ne peut plus être retirée. Pour y renoncer, utilisez « Renoncer » sur la commande (tant que le lot est en précommande), sinon contactez-nous. » (annulation de machines d'une commande payée : par le backoffice, voir `POST /api/backoffice/orders/{orderId}/cancel-lines`) ;
4. sinon : retrait, `204`.

Une facture **en attente** (non payée) qui reprend la wishlist n'est pas une conversion : le retrait est permis. Une ligne remboursée (commande annulée) ne convertit plus : le retrait redevient permis.

Concurrence : retrait et conversion ne se croisent pas. Le retrait verrouille la wishlist puis le lot (verrou partagé, en conflit avec celui que la conversion prend au paiement) : une conversion validée pendant le retrait est vue (`409 wishlist_converted`) ; un retrait validé avant le paiement reste acquis (le paiement, lui, est toujours accepté). Garanti aussi en base (trigger `Wishlist_guard_converted`, contrainte `Wishlist_converted` → `409 wishlist_converted`, même message). Retraits simultanés d'une même wishlist : tous `204`.

→ `204`. `401 unauthenticated`, `404 wishlist_not_found`, `409 wishlist_converted`.

---

## Profil (e-mail de contact)

Utilisateur connecté, son seul profil (`User`, créé à la première requête authentifiée). L'e-mail vit dans ce projet (auth-service n'en a pas) : il préremplit la facture suivante et l'équipe s'en sert pour contacter la personne. Donnée personnelle : visible du seul utilisateur et du backoffice, jamais dans les journaux. Format (imposé par la base, `User_email_check`, même règle que l'instantané de la facture) : `local@domaine.tld`, sans espace, 254 caractères au plus, casse conservée ; pas d'unicité.

### `GET /api/profile`
→ `200 { "email": "alice@exemple.fr" | null }`. `401 unauthenticated`.

### `PATCH /api/profile`
```json
{ "email": "alice@exemple.fr" }
```
Change l'e-mail (espaces de bord retirés). **Il ne s'efface pas** : `""`, `null` ou absent → `400 invalid_input` (« Adresse e-mail obligatoire : vous pouvez la changer, pas l'effacer »). → `200 { "email" }`. Erreurs : `400 invalid_input` (absent, vide, plus de 254 caractères, champ inconnu), `401 unauthenticated`, `422 invalid_contact_email` (format refusé : « Adresse e-mail invalide : indiquez une adresse de la forme nom@domaine.fr, sans espace. »). Les factures déjà créées gardent l'e-mail avec lequel elles ont été faites.

---

## Factures : précommande et commande (jalon 4)

Utilisateur connecté. **Une facture** = un utilisateur, un lot, **une ligne par machine** (configuration complète), payée **en totalité** en Bitcoin sur une adresse qui lui est propre (jamais réutilisée). Précommande, ou commande simple si le lot était en Tuning ou Packaging à la création (`kind`). Une facture n'est **jamais supprimée** : elle est annulée, expire ou est remboursée. Chacun ne voit que ses factures : celle d'un autre répond `404 order_not_found`, comme une facture inconnue.

Règles (imposées par la base, vérifiées avant par le serveur pour un message daté) :
- **Lot ouvert aux commandes** : palette de la Précommande au Packaging inclus, lot de stock en vente. Sondage : « pas encore ouvertes » ; En transit, clôturé, annulé : refusé (`409 batch_not_open`). Lot de stock en pause : `404 batch_not_found` (il n'est plus public) ; mis en pause pendant la création : `409 batch_not_open`, « Ce lot n'est pas en vente pour le moment. ».
- **Lot de stock** : mêmes règles anti-abus (facture vivante unique, réservation de 30 min, délai et blocage après abandons, plafond par facture) ; ni priorité ni wishlist ; stock épuisé : `409 out_of_stock`, « Plus aucune machine en stock pour le moment. » / « Il ne reste que N machines en stock : vous en demandez M. ». Pas de renoncement en ligne (rétractation sur le stock hors périmètre, en attente du juriste) : `409 order_renounce_closed`, « Une commande de machines en stock ne s'annule pas en ligne : contactez-nous. » ; l'admin peut annuler (`cancel-lines`).
- **Journée de priorité** (lot passé par le sondage, avec au moins une wishlist active) : pendant 1 jour après l'ouverture des précommandes, seules les personnes ayant une wishlist active commandent, **dans la limite du nombre de leurs wishlists** (machines déjà prises comprises). Elle se termine plus tôt quand toutes les wishlists actives sont converties (lignes payées qui les référencent : envoyez `wishlistId` sur les lignes qui en viennent, sinon la journée ne se termine pas plus tôt).
- **Une seule facture en attente vivante** par utilisateur et par lot.
- **Réservation de 30 min** à partir de la création (le stock est réservé, l'appoint ne la prolonge pas). Passé ce délai la facture s'affiche `expired` et libère sa place ; un paiement complet reçu ensuite est accepté s'il reste de la place, sinon remboursé.
- **Abandons** (facture annulée, expirée sans paiement complet, ou remboursée avant paiement complet **à la demande du client** : `refunds[].initiatedBy: "user"`), par utilisateur et par lot. **Une facture annulée par la fermeture du lot (`cancelReason: "batch_closed"` : pause d'un lot de stock, lot annulé, en transit ou clos) ou par l'admin (`cancelReason: "admin"`, décision de Hugo du 2026-11-16) n'est pas un abandon** (R4b), pas plus qu'une facture **remboursée à l'initiative de l'admin ou du système** (quel que soit le motif : `partial_payment`, `late_payment_no_room`, `shop_*`, `discount`…, décision de Hugo du 2026-11-16) : ni délai, ni événement de blocage, même si un versement arrivé ensuite est remboursé. Puis : **délai** de 5 min après chaque abandon (`429 order_cooldown` + `Retry-After`). **Blocage** (l1) : au **3e événement en 30 jours**, abandons et **renoncements** comptés ensemble (un renoncement = un remboursement de machines `user_renounce`, par l'utilisateur ou par l'admin à sa demande), plus aucune facture sur ce lot pendant **72 h** (`409 order_creation_blocked`, `details.blockEndsAt`) ; il **se lève seul** à l'échéance (horloge de la base), ou avant si l'admin le lève. Après un blocage échu, les événements jusqu'à son début ne comptent plus. Un renoncement ne déclenche pas le délai de 5 min. Valeurs : `ShopSettings` (`abandoned_order_limit`, `abandoned_order_window_hours`, `order_block_duration_hours`, bornée de 1 à 720 h).
- **10 machines au plus par facture** (`ShopSettings.order_max_lines`).
- **Prix** : jamais envoyés par le client, relus en base (prix de revente du lot, prix effectif des options), figés dans la facture. Montant attendu en sats calculé au taux du service de paiement au moment de la création, arrondi au sat supérieur, figé.

### Objet `Order`
```json
{
  "id": "uuid", "status": "pending_payment", "statusLabel": "En attente de paiement",
  "kind": "preorder", "kindLabel": "Précommande",
  "createdAt": "…", "expiresAt": "…", "paidAt": null, "cancelledAt": null, "cancelReason": null, "refundedAt": null,
  "batch": { "id": "uuid", "name": "10 S19", "kind": "wholesale", "status": "preorder", "statusLabel": "Précommande",
             "isPublic": true, "acceptsOrders": true, "model": { "id": "uuid", "name": "S19" } },
  "totalAmount": "107500",
  "channel": "online", "paymentMethod": "bitcoin",
  "payment": { "method": "bitcoin", "address": "bcrt1q…" | null, "expectedSats": "1194445" | null, "receivedSats": "0",
               "receivedCents": "0", "refundedCents": "0",
               "outstandingSats": "1194445", "refundedSats": "0", "underReviewSats": "0",
               "surplusLeftSats": "0", "paidAfterRefundSats": "0" },
  "refundAddress": "bc1q…" | null,
  "contactEmail": "alice@exemple.fr" | null,
  "dismissal": null | { "sats": "800", "networkFeeSats": "2000", "createdAt": "…" },
  "lines": [{ "id": "uuid", "position": 1, "amount": "57500", "basePrice": "50000", "wishlistId": "uuid" | null, "refunded": false, "machineAssigned": false,
              "items": [{ "optionId": "uuid", "optionTitle": "Kit de ventilation", "optionValueId": "uuid", "label": "Silent kit", "isDefault": false, "unitPrice": "7500" }] }],
  "payments": [{ "id": "uuid", "method": "bitcoin", "amountSats": "1194445", "txid": "…", "vout": 0,
                "amountCents": null, "offchainMeans": null, "offchainMeansLabel": null, "reference": null, "receivedAt": "…" }],
  "refunds": [{ "id": "uuid", "method": "bitcoin", "kind": "cancellation", "kindLabel": "Annulation",
                "cause": "partial_payment", "causeLabel": "Remboursement d'un paiement partiel", "initiatedBy": "user",
                "amount": "107500", "amountSats": "298000", "networkFeeSats": "2000", "networkFeePayer": "user",
                "destinationAddress": null, "reason": "…", "createdAt": "…", "sentAt": null, "reference": null }],
  "billingAddress": Address, "shippingAddress": Address,
  "actions": { "canCancel": true, "canRequestRefund": false, "awaitingTopUp": false, "canRenounce": false, "canEditRefundAddress": true },
  "awaitingUserDecision": false
}
```
| Champ | Sens |
|---|---|
| `status` | `pending_payment` (en attente), `paid` (payée), `expired` (réservation passée sans paiement complet ; **affiché** dès `expiresAt` dépassé, même si la base n'a pas encore écrit le statut), `refunded` (le prix payé est remboursé ; un excédent éventuel reste traité par l'équipe : `underReviewSats`), `cancelled` (annulée en attente, rien reçu ; qui l'a annulée : `cancelReason`) |
| `cancelReason` | cause de l'annulation, **posée par la base** (v5l) en même temps que `cancelledAt` : `user` (le client a annulé lui-même sa facture en attente), `batch_closed` (le lot est passé à un statut qui ferme les commandes : Annulé, En transit, Clôturé), `admin` (annulée par la boutique). `null` : facture jamais annulée (une expiration reste `expired`, sans cause). **Conservée** si la facture annulée est ensuite acceptée (`paid`) ou remboursée (`refunded`), comme `cancelledAt` : « versement reçu après l'annulation par le lot ». Les factures annulées avant la v5l ont été reprises (`batch_closed` si le lot a fermé les commandes dans les 10 s qui ont suivi l'annulation, sinon `user`) |
| `kind` | `preorder` (Précommande) ou `order` (Commande : palette en Tuning ou Packaging à la création, ou lot de stock) |
| `batch.kind` | `wholesale` ou `stock` ; `batch.statusLabel` d'un lot de stock : « En vente » ou « En pause » |
| `shipment` | envoi de la facture (R6 lot 2) : `{ carrier, trackingNumber, trackingUrl, shippedAt, deliveredAt }` ou `null` (voir « Envoi d'une facture ») |
| `channel`, `paymentMethod` | `online` + `bitcoin` (tunnel de la boutique) ou `manual` + `offchain` (vente saisie par l'équipe, payée hors chaîne, refonte R5b : voir « Vente manuelle et paiement hors chaîne »). Une vente hors chaîne n'a ni adresse de paiement (`payment.address: null`), ni montant en sats (`payment.expectedSats: null`, sats à `"0"`), ni adresse de remboursement ; ses montants sont en centimes : `payment.receivedCents` (encaissé) et `payment.refundedCents` (remboursé, rendu ou à rendre), `"0"` pour une facture Bitcoin |
| `payments[]` | Bitcoin : `amountSats`, `txid`, `vout` (le reste `null`) ; hors chaîne : `amountCents`, `offchainMeans` (`cash`, `bank_transfer`, `other`) et son libellé (« Espèces », « Virement », « Autre »), `reference` (le reste `null`) |
| `refunds[].method` | moyen de la facture : `bitcoin` (sats envoyés à une adresse) ou `offchain` (`amount` en euros rendus ; `amountSats`, `networkFeeSats`, `destinationAddress` à `null`, `networkFeePayer: "shop"`) |
| `payment.address` | adresse Bitcoin de la facture : l'utilisateur y paie `expectedSats`, en une ou plusieurs fois. Simulée au jalon 4 : préfixe `bcrt1q` (réseau de test, jamais une adresse réelle) |
| `payment.outstandingSats` | appoint attendu (facture en attente ou expirée), 0 sinon |
| `payment.fullPaymentHold` | (R4b, exposé dans `Order` et `AdminOrder` ; vue `order_payment_balance.full_payment_hold`) facture en attente ou expirée **dont tout est payé** (`outstandingSats` = `"0"`) mais pas encore acceptée : **rien à payer**, ne pas afficher les instructions de paiement. Raison : `settling` (validation automatique en cours : la commande va passer payée), `no_room` (plus de machine disponible : la boutique rembourse tout, frais à sa charge, à la fin de la réservation), `batch_closed` (le lot a fermé aux commandes pendant le paiement : l'équipe décide, accepter ou rembourser). `null` : autre cas (rien reçu, paiement partiel, facture payée, remboursée, annulée). Toujours « à traiter » au backoffice. Une réservation vivante garde toujours sa place (`Batch_stock` refuse qu'une machine réservée devienne invendable) : `no_room` ne concerne qu'un paiement tardif |
| `payment.refundedSats` | sats sortis du solde par les remboursements (frais réseau à la charge de l'utilisateur compris : excédent, paiement partiel) |
| `payment.underReviewSats` | sats reçus que l'**équipe** doit encore traiter (« à traiter » au backoffice) : excédent d'une facture payée (quel qu'en soit le montant, voir ci-dessous), excédent resté après l'annulation de toute la commande (renoncement compris), paiement arrivé après un remboursement intégral ou une annulation (lot annulé compris), ou sur un lot qui n'accepte plus de commande. `"0"` : rien. Aucun remboursement automatique : l'équipe contacte la personne. À afficher (« votre versement est traité par notre équipe ») au lieu d'un statut muet. Pour une facture `refunded`, `underReviewSats` = `surplusLeftSats` + `paidAfterRefundSats` |
| `payment.surplusLeftSats` | facture `refunded` seulement (sinon `"0"`) : **surplus resté**, sats reçus **avant** le remboursement intégral et toujours non traités (excédent d'une commande payée puis annulée en entier, renoncement compris : le prix est rendu, l'excédent reste à l'équipe). Toujours `"0"` pour une facture jamais acceptée (tout le reçu lui a été rendu) |
| `payment.paidAfterRefundSats` | facture `refunded` seulement (sinon `"0"`) : sats d'un **versement arrivé après le remboursement intégral** et toujours non traités. Les deux montants viennent de la base (vue `order_payment_balance`) : l'écran ne compare aucune date. Un remboursement ou classement fait par l'équipe après le remboursement intégral est imputé d'abord au surplus resté |
| `refundAddress` | adresse Bitcoin où rembourser, **obligatoire à la création** depuis l1, remplaçable par l'utilisateur (`PATCH …/refund-address`, remboursement du versement) ou par l'admin tant qu'aucun remboursement de la facture n'est envoyé, **jamais effacée**. `null` : seulement une facture antérieure à l1 sans adresse (un remboursement à envoyer est alors « à traiter », l'admin contacte la personne) |
| `contactEmail` | e-mail donné pour cette facture (instantané figé, jamais modifié) ; `null` : facture antérieure à la v5i |
| `dismissal` | sats reçus **classés sans suite** par l'équipe (au plus les frais réseau d'un remboursement : les renvoyer coûterait autant qu'ils valent), une fois par facture ; `null` : aucun. Ils ne comptent plus dans `underReviewSats` |
| `lines` | une par machine, **dans l'ordre de la requête de création** : `position` 1, 2, 3… (posée par la base, « Machine 1, 2… »). `refunded` : machine annulée et remboursée |
| `refunds[].kind` | `cancellation` (machines annulées), `discount` (rabais), `overpayment` (excédent, `amount` = 0) |
| `refunds[].cause` | motif, qui fixe **qui paie les frais réseau** (règle unique en base, `refund_cause_fee_payer`) : boutique pour `shop_stock` (stock, surplus, lot abandonné), `shop_defective_machine`, `late_payment_no_room`, `discount`, `admin_other`, `user_renounce` (renoncement, depuis l1 ; avant : utilisateur, les remboursements déjà créés gardent leur payeur) ; utilisateur pour `partial_payment`, `overpayment`. `causeLabel` : libellé français |
| `refunds[].initiatedBy` | `user` (renoncement, remboursement du versement), `admin`, `system` (traitement automatique) |
| `refunds[].networkFeePayer` | `shop` (frais tracés, jamais déduits : `amountSats` = tout le brut) ou `user` (frais déduits : `amountSats` = brut − frais ; excédent et paiement partiel seulement) |
| `refunds[].destinationAddress` | adresse choisie par l'admin pour ce remboursement, puis celle de l'envoi ; `null` avant l'envoi : l'adresse de la facture (`refundAddress`) s'applique |
| `refunds[].sentAt`, `reference` | envoi du remboursement (transaction), enregistré par l'admin (`POST /api/backoffice/refunds/{refundId}/send`) ; `null` tant qu'il n'est pas parti |
| `actions` | **indications** pour l'UI, qui n'empêche rien (l'API tranche) : `canCancel` (en attente, rien reçu), `canRequestRefund` (paiement partiel, lot ouvert : remboursement du versement), `awaitingTopUp` (versement reçu incomplet, appoint possible), `canRenounce` (commande payée, lot au plus en Précommande), `canEditRefundAddress` (aucun remboursement envoyé) |
| `awaitingUserDecision` | facture expirée partiellement payée : l'utilisateur choisit l'appoint (payer le reste à la même adresse) ou le remboursement de son versement |

**Address** : `{ "id": "uuid", "fullName": "Alice Martin", "company": null, "line1": "1 rue de la Paix", "line2": null, "postalCode": "69001", "city": "Lyon", "country": "FR", "phone": null }`. Donnée personnelle : visible du seul utilisateur et du backoffice.

### `POST /api/orders`
```json
{
  "batchId": "uuid",
  "lines": [
    { "wishlistId": "uuid" },
    { "choices": [{ "optionId": "uuid", "optionValueId": "uuid" }] },
    {}
  ],
  "billingAddress": { "fullName": "Alice Martin", "company": null, "line1": "1 rue de la Paix", "line2": null,
                      "postalCode": "69001", "city": "Lyon", "country": "FR", "phone": null },
  "shippingAddress": { "addressId": "uuid" },
  "refundAddress": "bc1q…",
  "contactEmail": "alice@exemple.fr"
}
```
- `lines` : une entrée par machine (1 à 1 000 dans la requête ; plafond métier : `maxMachinesPerOrder`). `wishlistId` : reprend la configuration d'une de **ses** manifestations d'intérêt du lot (active, non convertie) et la référence ; `choices` : choix libres (un menu non choisi reçoit son défaut) ; `{}` : tous les défauts. Pas les deux sur une même ligne ; une wishlist au plus une fois.
- `billingAddress` / `shippingAddress` : une adresse saisie (`fullName`, `line1`, `postalCode`, `city` obligatoires ; `country` code ISO à deux lettres, mis en majuscules) ou `{ "addressId" }` d'une adresse enregistrée (`GET /api/addresses`). Une adresse saisie identique à une adresse enregistrée est reprise. `shippingAddress` absente : même adresse que la facturation.
- `refundAddress` : **obligatoire** (l1), adresse Bitcoin où rembourser si besoin ; journalisée avec son auteur. Absente, `null` ou mal formée : `400 invalid_input`, `issues: [{ path: "refundAddress", message: "Adresse Bitcoin attendue" }]` ; la base l'impose aussi (`Order_refund_address_required` → `422 refund_address_required`).
- `contactEmail` : e-mail de contact de la facture (254 caractères au plus, espaces de bord retirés, casse conservée). **Facultatif si le profil en a un** (`profileEmail` de `GET /api/orders/eligibility`, à préremplir), obligatoire sinon ; `""` ou `null` = absent. Un e-mail saisi qui **diffère du profil y est mémorisé** (`User.email`), dans la même transaction que la facture (la facture échoue : le profil n'est pas changé). Absent : celui du profil est repris. La facture garde son instantané (`contactEmail`), jamais modifié.
- Aucun prix ni montant en entrée (`400 invalid_input`).

→ `201 Order`. Erreurs, dans l'ordre des contrôles :

| Code | Cas | `details` |
|---|---|---|
| `400 invalid_input` | entrée invalide, wishlist commandée deux fois, ligne avec `wishlistId` et `choices` | |
| `401 unauthenticated` | | |
| `404 batch_not_found` | lot inconnu ou en brouillon | |
| `409 batch_not_open` | lot au sondage (« pas encore ouvertes »), en transit, clôturé, annulé ; lot de stock mis en pause (« Ce lot n'est pas en vente pour le moment. ») | `batchStatus` |
| `409 order_priority_window` | journée de priorité, aucune machine permise (pas de wishlist, ou quota pris) ; le message donne la fin (« jusqu'au 8 octobre à 10:30 ») | `priorityEndsAt`, `machinesLeft: 0` |
| `409 order_already_pending` | une facture en attente vivante existe déjà sur ce lot | `orderId` |
| `409 order_creation_blocked` | bloqué sur ce lot après trop d'abandons et de renoncements, jusqu'à la levée automatique (« … suspendues pour vous sur ce lot jusqu'au 8 novembre à 17:41. ») | `blockedAt`, `blockEndsAt` |
| `429 order_cooldown` + `Retry-After` | délai après un abandon : « vous pourrez en créer une nouvelle à 14:35 » | `cooldownEndsAt` |
| `422 order_too_many_lines` | plus de machines que le plafond par facture (le message cite le vrai plafond) | `maxLines` |
| `409 order_priority_quota` | journée de priorité : plus de machines que permis (« vous pouvez encore prendre 2 machines en priorité ») | `priorityEndsAt`, `machinesLeft` |
| `409 out_of_stock` | stock insuffisant (« il ne reste que 2 machines ») | `available` |
| `409 option_out_of_stock` | une option dépasse sa quantité maximale sur le lot | |
| `404 wishlist_not_found` | wishlist inconnue, retirée ou d'un autre | |
| `422 wishlist_other_batch` | wishlist d'un autre lot | |
| `409 wishlist_converted` | wishlist déjà convertie en commande payée | |
| `422 option_not_offered` | choix non proposé par le lot (message qui le nomme) | |
| `422 unknown_address` | `addressId` inconnu ou d'un autre | |
| `422 refund_address_ours` | `refundAddress` est une adresse de paiement de la boutique | |
| `422 refund_address_required` | refusé par la base sans adresse (dernier rempart : le schéma d'entrée répond `400` avant) | |
| `422 contact_email_required` | ni `contactEmail` ni e-mail au profil (« Indiquez une adresse e-mail : l'équipe s'en sert pour vous contacter au sujet de votre commande. ») ; contrôlé après les règles du lot, imposé aussi par la base (`Order_contact_email_required`, v5k) | |
| `422 invalid_contact_email` | `contactEmail` au mauvais format (`User_email_check`, `Order_contact_email_check`) | |

Concurrence : les créations d'un même utilisateur se suivent (verrou de l'utilisateur) ; le stock est contrôlé sous verrou du lot au COMMIT : 4 clients pour 2 places, 2 factures.

### `GET /api/orders`
Paramètre facultatif `batchId`. → `200 { "items": [Order] }`, de la plus récente à la plus ancienne (toutes, annulées et remboursées comprises).

### `GET /api/orders/{orderId}`
→ `200 Order`. `404 order_not_found`.

### `GET /api/orders/eligibility?batchId=uuid`
Ce que l'utilisateur peut commander maintenant sur le lot, pour afficher les messages **avant** l'envoi (l'UI n'empêche rien : `POST /api/orders` tranche).
```json
{
  "batchId": "uuid", "batchKind": "wholesale", "batchStatus": "preorder", "acceptsOrders": true,
  "priorityEndsAt": "2026-10-08T08:30:00.000Z", "priorityMachinesLeft": 2,
  "pendingOrderId": null, "blockedAt": null, "blockEndsAt": null, "cooldownEndsAt": null,
  "availableQuantity": 7, "maxMachinesPerOrder": 10,
  "wishlistIds": ["uuid", "uuid"],
  "orders": [{ "id": "uuid", "status": "paid", "statusLabel": "Payée", "createdAt": "…" }],
  "profileEmail": "alice@exemple.fr",
  "refusal": null
}
```
`blockedAt` / `blockEndsAt` : blocage en cours sur ce lot (début, levée automatique), `null` sinon. `profileEmail` : e-mail du profil pour préremplir `contactEmail` (`null` : à saisir, obligatoire). `priorityMachinesLeft` : machines encore permises en priorité (« vous pouvez encore prendre N machines »), `null` hors journée de priorité. `orders` (R4b) : ses factures sur ce lot, la plus récente d'abord (lien « Mes commandes » vers `/mes-commandes/{id}`). `wishlistIds` : ses wishlists actives non converties sur ce lot, à reprendre en `lines[].wishlistId`. `refusal` : `{ code, message, details }` qu'aurait une facture d'une machine maintenant, `null` sinon. → `200`. `400 invalid_input` (`batchId` absent ou mal formé), `404 batch_not_found` (inconnu ou brouillon).

### `POST /api/backoffice/orders/{orderId}/cancel` (jalon 5 bis)
Corps `{}`. Annule une facture **en attente, rien reçu, réservation vivante**, par l'admin : réservation libérée, `cancelReason: "admin"` (geste de la boutique, **jamais un abandon** du client : ni délai ni plafond). Rejouée : `200` sans effet. Libère les places que `409 machine_shortage_reserved` voyait occupées (refaire ensuite l'écriture refusée). → `200 AdminOrder`. Erreurs : `404 order_not_found`, `409 order_cancel_paid` (un paiement a été reçu : « À traiter »), `409 order_cancel_expired`, `409 order_not_cancellable` (payée, remboursée), `403 forbidden`.

### `POST /api/orders/{orderId}/cancel`
Corps `{}`. Annule une facture **en attente, rien reçu, réservation vivante** : la place est libérée tout de suite. C'est un abandon (délai, plafond). Rejouée sur une facture déjà annulée : `200` sans effet.
→ `200 Order` (`status: "cancelled"`, `cancelledAt` et `cancelReason: "user"` posés par la base ; déjà annulée, par exemple par la fermeture du lot dans la même seconde : sans effet, `cancelReason` inchangée). `404 order_not_found`, `409 order_cancel_paid` (un paiement a été reçu : demander le remboursement du versement ou compléter), `409 order_cancel_expired` (déjà expirée), `409 order_not_cancellable` (payée, remboursée).

Un paiement qui arrive sur une facture annulée n'est jamais refusé : la facture devient « à traiter » au backoffice.

### `POST /api/orders/{orderId}/refund`
Remboursement du **versement partiel** (avant comme après l'expiration), **frais réseau à la charge de l'utilisateur** (estimés par le service de paiement, déduits de ce qu'il reçoit ; motif `partial_payment`). Une transaction : remboursement de toutes les machines, facture remboursée. C'est un abandon (délai, plafond).
```json
{ "refundAddress": "bc1q…" }
```
`refundAddress` facultative : si elle est donnée, elle **remplace celle de la facture** (`refundAddress`, journalisée comme un `PATCH`) ; sinon celle de la facture s'applique ; sans aucune (facture antérieure à l1), l'admin contacte l'utilisateur avant l'envoi. Le remboursement lui-même n'a pas d'adresse propre (`destinationAddress: null`).
→ `200 Order` (`status: "refunded"`, `refunds[0]` : `cause: "partial_payment"`, `initiatedBy: "user"`, `networkFeePayer: "user"`, `amountSats` = reçu − frais). Erreurs : `400 invalid_input` (adresse Bitcoin attendue), `404 order_not_found`, `409 order_nothing_received` (rien reçu : annuler plutôt), `409 refund_below_network_fee` (le versement ne couvre pas les frais : compléter le paiement ; `details: { receivedSats, networkFeeSats }`), `409 refund_not_allowed` (paiement complet, facture payée ou annulée, lot fermé aux commandes : la boutique s'en charge), `409 order_already_refunded`, `422 refund_address_ours`.

### `PATCH /api/orders/{orderId}/refund-address`
Donner (facture antérieure à l1 sans adresse) ou changer l'adresse de remboursement d'une de **ses** factures, tant qu'aucun remboursement de la facture n'est envoyé. Elle **ne s'efface plus** (l1). Chaque changement est journalisé avec son auteur (lisible au backoffice).
```json
{ "refundAddress": "bc1q…" }
```
→ `200 Order`. Erreurs : `400 invalid_input` (adresse Bitcoin attendue, champ absent ou `null`), `401 unauthenticated`, `404 order_not_found` (inconnue ou d'un autre), `409 refund_address_frozen` (un remboursement est déjà envoyé : « contactez-nous »), `422 refund_address_ours` (adresse de paiement de la boutique).

Concurrence : le changement et l'envoi d'un remboursement prennent le même verrou (la facture). Un envoi validé d'abord fait échouer le changement (`409 refund_address_frozen`) ; un changement validé d'abord fait échouer l'envoi vers l'ancienne adresse (`409 refund_destination_changed` côté admin).

### `POST /api/orders/{orderId}/renounce`
Renoncer à des machines d'une **commande payée** (ou à toute la commande), **tant que le lot est au plus en Précommande** (après : `409 order_renounce_closed`, « contactez-nous » ; l'admin peut alors annuler à sa demande par `cancel-lines` avec `cause: "user_renounce"`). Remboursement au prorata de ce qui a été payé (arrondi au sat le plus proche sur le cumul), **sans déduction : frais réseau à la charge de la boutique** (motif `user_renounce`, depuis l1), vers l'adresse de la facture (`refundAddress`, à donner par `PATCH …/refund-address` si une facture antérieure à l1 n'en a pas). Toute la commande : elle passe à `refunded`. **L'excédent de paiement éventuel ne part pas avec le renoncement** (décision Hugo 2026-10-09, imposé par la base depuis la v5k : `Refund_cause_check`) : il reste `underReviewSats`, l'équipe contacte la personne puis le rembourse ou le classe sans suite. À annoncer avant la confirmation. Ce n'est pas un abandon de la facture et il ne déclenche pas le délai, mais **il compte pour le blocage** (3 abandons ou renoncements en 30 jours sur le lot : 72 h, voir plus haut).
```json
{ "lineIds": ["uuid"] }
```
`lineIds` facultatif (absent : toutes les machines encore actives). → `200 Order`. Erreurs : `400 invalid_input`, `401 unauthenticated`, `404 order_not_found` (inconnue ou d'un autre), `409 order_not_paid` (facture non payée ou déjà remboursée), `409 order_renounce_closed` (lot au-delà de la Précommande ; lot de stock : toujours), `422 unknown_order_line` (machine d'une autre commande ou déjà remboursée). Plus de `409 refund_below_network_fee` : les frais ne sont jamais déduits d'un renoncement.

Concurrence : sérialisé avec les transitions du lot (verrou du lot). Un passage à Commande en cours validé d'abord fait échouer le renoncement (`409 order_renounce_closed`) ; un renoncement validé d'abord fait attendre la transition, qui passe ensuite.

### `GET /api/addresses`
→ `200 { "items": [Address] }` : adresses enregistrées de l'utilisateur (non archivées), de la plus récente à la plus ancienne. Pour préremplir la facturation et la livraison.

---

## Paiement : point d'entrée interne (service de paiement simulé)

Au jalon 4 le service de paiement Bitcoin est **simulé** (`src/server/payment-service.ts`) : adresse unique `bcrt1q…` par facture, taux EUR→BTC fixé en configuration (`PAYMENT_BTC_PRICE_EUR_CENTS`, défaut 90 000,00 €), frais réseau estimés d'un remboursement fixés (`PAYMENT_REFUND_NETWORK_FEE_SATS`, défaut 2 000 sats). Le vrai service maison remplacera cette implémentation (même interface) et appellera le point d'entrée ci-dessous.

### `POST /api/internal/payments`
**Jamais appelé par le navigateur.** En-tête `Authorization: Bearer <PAYMENT_WEBHOOK_SECRET>` (secret Swarm, ≥ 32 caractères en production). Sans secret configuré, la route répond `404` (fermée). À ne pas exposer par le reverse proxy public.
```json
{ "address": "bcrt1q…", "txid": "…", "vout": 0, "amountSats": "1194445" }
```
1. Le paiement est enregistré (journal `Payment`, **jamais refusé**), idempotent sur `txid` + `vout`.
2. Traitement automatique, **seulement si aucune décision humaine n'est attendue** :
   - paiement complet d'une facture non acceptée, lot ouvert : **payée** s'il reste de la place (contrôle sous verrou du lot), sinon **remboursée intégralement** (paiement tardif sans place, frais à la charge de la boutique) ;
   - **excédent** d'une facture payée : **jamais remboursé d'office, quel qu'en soit le montant** (décision Hugo 2026-10-09, aucun seuil) ; la facture reste payée, elle est « à traiter » (`overpayment_decision`, `payment.underReviewSats` côté client) et l'admin décide. La base refuse un remboursement d'excédent de l'initiateur `system` (`Refund_cause_check`, v5h) ;
   - paiement partiel : rien (appoint attendu) ; paiement sur une facture annulée, remboursée, ou d'un lot fermé : rien, « à traiter » au backoffice.

→ `201` (nouveau paiement) ou `200` (rejoué à l'identique) :
```json
{
  "duplicate": false,
  "payment": { "id": "uuid", "orderId": "uuid", "amountSats": "1194445", "txid": "…", "vout": 0, "receivedAt": "…" },
  "actions": ["accepted"],
  "order": { "id": "uuid", "status": "paid", "expectedSats": "1194445", "receivedSats": "1194445", "outstandingSats": "0",
             "awaitingUserDecision": false, "needsAdminAttention": false }
}
```
`actions` ⊂ `accepted`, `refunded_no_stock` (le seul remboursement automatique restant : paiement complet tardif sans place). Rejouer le même appel est sans danger (rien n'est compté deux fois, le traitement reprend). Erreurs : `401 unauthenticated` (secret absent ou faux), `404` (route fermée), `404 unknown_payment_address`, `409 payment_conflict` (même `txid` + `vout` déjà enregistré pour une autre facture ou un autre montant), `400 invalid_input`.

Pour simuler un paiement en développement : `curl -X POST localhost:3000/api/internal/payments -H "Authorization: Bearer $PAYMENT_WEBHOOK_SECRET" -H "Content-Type: application/json" -d '{"address":"bcrt1q…","txid":"t1","vout":0,"amountSats":"1194445"}'`.

---

## Backoffice : factures, « à traiter », blocages

Whitelist. Qui paie les frais réseau d'un remboursement découle **toujours de son motif** (`refund_cause_fee_payer`, en base), jamais d'un choix libre : l'admin choisit le motif parmi ceux permis pour le cas.

**AdminOrder** = `Order` plus :
```json
{ "user": { "id": "uuid", "authUserId": "42" | null }, "profileEmail": "alice@exemple.fr" | null,
  "lines": [{ "…": "comme Order", "machineId": "uuid" | null, "machineSerial": "…" | null }],
  "manualSale": null | { "createdBy": "1", "reason": "Vente au comptoir" },
  "refundableAmount": "107500",
  "unsettledSats": "0", "refundDueSats": "0", "abandonedAt": null,
  "dismissal": null | { "sats": "800", "networkFeeSats": "2000", "reason": "Client prévenu" | null, "dismissedBy": "1", "createdAt": "…" },
  "attention": null | { "reason": "admin_decision", "label": "…", "canAccept": true, "canRefund": true,
                        "refundCauses": [{ "cause": "admin_other", "label": "Autre décision de la boutique", "networkFeePayer": "shop" }],
                        "canDismiss": false, "networkFeeSats": "2000" },
  "cancelLineCauses": [{ "cause": "shop_stock", "label": "Souci de stock (surplus, lot abandonné)", "networkFeePayer": "shop" }],
  "refundAddressChanges": [{ "id": "uuid", "oldAddress": null, "newAddress": "bc1q…", "actor": "user", "actorAuthUserId": "42", "createdAt": "…" }] }
```
- `user.authUserId` (et `customer.authUserId` des machines, `user.authUserId` de « À traiter », des remboursements et des blocages) : toujours renseigné (tout client a un compte, créé par lui-même, y compris pour une vente manuelle).
- `contactEmail` (de `Order`) : e-mail donné pour la facture ; `profileEmail` : e-mail **actuel** du profil. Afficher les deux s'ils diffèrent (liens `mailto:`). Pas de correction par l'admin.
- `dismissal` : classement sans suite (`POST …/dismiss-excess`), avec le motif et l'admin (`dismissedBy`, identifiant auth-service).
- `attention.canDismiss` : « Classer sans suite » possible : facture payée, remboursée ou annulée, `0 < unsettledSats <= networkFeeSats` (frais réseau estimés d'un remboursement), pas encore classée (une fois par facture, même si un nouveau versement arrive ensuite).
- `unsettledSats` : sats reçus non affectés (ni acceptés pour la marchandise, ni remboursés, ni classés sans suite). `refundDueSats` : excédent d'une facture payée à rembourser. `abandonedAt` : date de l'abandon compté (délai, plafond).
- `refunds[]` porte en plus `createdBy` (admin qui l'a décidé, sinon `null`) et `sentBy` (admin qui a enregistré l'envoi ; `null` : pas envoyé ou envoyé par le service de paiement).
- `attention.refundCauses` : motifs proposés pour « Rembourser » (vide si rien à rembourser), avec le payeur des frais qui en découle.
- `cancelLineCauses` : motifs de `cancel-lines` (commande payée : `shop_stock`, `shop_defective_machine`, `user_renounce`, `admin_other` ; vente hors chaîne : sans `user_renounce`), sinon vide.
- `manualSale` : vente saisie par l'équipe (canal `manual`) : admin (`createdBy`, identifiant auth-service) et motif ; `null` pour une commande en ligne.
- `payments[]` porte en plus `recordedBy` : admin qui a enregistré un encaissement hors chaîne (`null` en Bitcoin).
- `refundableAmount` : centimes encore remboursables (total − annulations et rabais) ; un rabais (`POST …/discount`) reste strictement en dessous.
- `user_renounce` ne figure jamais dans `attention.refundCauses` : une annulation à la demande de l'utilisateur passe par `cancel-lines` ; l'excédent qui reste après l'annulation de toute la commande se décide ensuite comme tout excédent (`overpayment`, `admin_other`, ou classement sans suite).
- `refundAddressChanges` : journal **en lecture seule** des changements d'adresse de remboursement (saisie, modification ; effacement seulement avant l1 ; auteur `user` ou `admin`), du plus ancien au plus récent.

### `GET /api/backoffice/orders/attention`
« À traiter », les plus anciennes d'abord :
```json
{ "items": [{
  "orderId": "uuid", "channel": "online", "paymentMethod": "bitcoin",
  "batch": { "id": "uuid", "name": "10 S19", "status": "preorder", "statusLabel": "Précommande" },
  "user": { "id": "uuid", "authUserId": "42" }, "contactEmail": "alice@exemple.fr" | null, "profileEmail": "alice@exemple.fr" | null,
  "status": "cancelled", "statusLabel": "Annulée", "cancelReason": "batch_closed", "createdAt": "…",
  "machines": 1, "totalAmount": "50000", "expectedSats": "555556" | null, "receivedCents": "0", "refundedCents": "0", "receivedSats": "555556", "refundedSats": "0",
  "unsettledSats": "555556", "outstandingSats": "0",
  "attention": { "reason": "admin_decision", "label": "Paiement complet reçu après l'annulation : accepter la commande s'il reste de la place, sinon rembourser.", "canAccept": true, "canRefund": true,
                 "refundCauses": […], "canDismiss": false, "networkFeeSats": "2000" }
}] }
```
`attention` a la même forme que dans `AdminOrder`. `cancelReason` : comme dans `Order` (`null` si jamais annulée). Vente hors chaîne : `expectedSats: null`, sats à `"0"`, montants en `receivedCents` / `refundedCents`. Chaque facture que la base signale (`order_payment_balance.needs_admin_attention`) a un motif côté serveur (test d'égalité).
| `attention.reason` | Cas | Actions |
|---|---|---|
| `admin_decision` | paiement reçu après une annulation, sur une facture impayée d'un lot fermé aux commandes, ou sats restés sur une facture remboursée (excédent laissé par l'annulation de toute la commande, versement arrivé ensuite) | rembourser ; accepter si annulée, payée intégralement, lot ouvert et rien de classé sans suite ; classer sans suite si `canDismiss` |
| `user_decision` | facture expirée partiellement payée : **contacter l'utilisateur** (appoint ou remboursement de son versement, frais à sa charge). Sans réponse : l'admin la rembourse (motif `partial_payment`, frais à la charge de l'utilisateur, motif écrit obligatoire) | rembourser |
| `awaiting_decision` | paiement complet resté sans traitement automatique. Le libellé dit s'il ne tient plus dans le stock (`fits_stock`) : réservation encore vivante → « Accepter » répond `409 out_of_stock` jusqu'à la fin de la réservation, puis rembourse | accepter |
| `overpayment_decision` | facture payée dont l'excédent n'est pas remboursé (aucun excédent n'est remboursé d'office, quel qu'en soit le montant) : contacter le client, puis décider | rembourser (`admin_other` : frais boutique, ou `overpayment` : frais utilisateur, **proposé seulement si l'excédent dépasse les frais**), classer sans suite si `canDismiss`, ou attendre |
| `refund_address_missing` | un remboursement à envoyer n'a pas d'adresse (facture antérieure à l1 : l'adresse est obligatoire depuis) : contacter l'utilisateur, puis `PATCH …/refund-address` ou envoyer vers l'adresse obtenue | aucune |
| `offchain_refund_unsent` | vente hors chaîne : un remboursement en euros est décidé mais pas encore rendu au client | rendre l'argent, puis enregistrer l'envoi (`POST /api/backoffice/refunds/{refundId}/send`, référence seule) |

Motifs permis par cas pour « Rembourser » (`attention.refundCauses`) :

| Cas | Nature | Motifs |
|---|---|---|
| `user_decision` (réservation terminée) | annulation de toutes les machines | `partial_payment` (frais utilisateur), `admin_other` |
| `overpayment_decision` | excédent | `admin_other`, `overpayment` (frais utilisateur) |
| facture remboursée avec un reste (excédent après annulation complète, versement arrivé ensuite) | excédent | `overpayment` (frais utilisateur), `admin_other` |
| facture annulée, ou impayée d'un lot fermé | annulation de toutes les machines | `admin_other`, `shop_stock` (lot abandonné compris), `late_payment_no_room` si le paiement est complet |

Un motif dont les **frais sont à la charge de l'utilisateur** (`overpayment`, `partial_payment`) n'est **pas proposé** quand la somme à rembourser ne couvre pas les frais réseau (`unsettledSats` ≤ frais) : seul le motif aux frais de la boutique reste (le serveur refuserait l'autre, `409 refund_below_network_fee`).

### `GET /api/backoffice/orders/{orderId}`
→ `200 AdminOrder` (adresses, paiements, remboursements). `404 order_not_found`.

### `GET /api/backoffice/batches/{batchId}/orders`
→ `200 { "items": [AdminOrder] }` : toutes les factures du lot, de la plus récente à la plus ancienne. `404 batch_not_found`.

### `POST /api/backoffice/orders/{orderId}/accept`
Corps `{}`. Accepter une facture « à traiter » (`attention.canAccept`) : payée s'il reste de la place (contrôle sous verrou du lot) ; un excédent éventuel reste « à traiter » (aucun excédent n'est remboursé d'office). Sur un lot de stock, les machines libres sont attribuées aux lignes dans la même transaction, au nom de l'admin (R4b). Paiement complet resté sans traitement, plus de place : remboursé intégralement si la réservation est terminée (`late_payment_no_room`, frais boutique). → `200 AdminOrder`. `404 order_not_found`, `409 order_not_acceptable`, `409 out_of_stock` (facture annulée sans place : la rembourser ; réservation encore vivante qui ne tient plus : rien n'est fait, `details: { expiresAt }`), `409 batch_not_open`.

### `POST /api/backoffice/orders/{orderId}/refund`
```json
{ "reason": "Paiement reçu après annulation", "cause": "admin_other", "destinationAddress": "bc1q…" }
```
Rembourser ce qui a été reçu et n'est pas affecté (`attention.canRefund`) : annulation de toutes les machines et facture remboursée (facture annulée, impayée d'un lot fermé, ou expirée partiellement payée sans réponse de l'utilisateur) ; ou excédent (facture payée, ou paiement arrivé après un remboursement intégral). `reason` (texte libre) et `cause` (parmi `attention.refundCauses`) **obligatoires** ; le payeur des frais découle du motif. `destinationAddress` facultative : adresse où envoyer **ce** remboursement si l'admin en choisit une autre que celle de la facture. → `200 AdminOrder`. `400 invalid_input` (`issues` lisibles : « Choisissez l'un des motifs proposés » pour `cause`, « Explication obligatoire » pour `reason`), `404 order_not_found`, `409 order_reservation_running` (paiement partiel, réservation en cours : seul l'utilisateur choisit ; `details: { expiresAt }`), `409 payment_must_be_accepted` (paiement complet sur un lot ouvert : accepter), `409 order_nothing_to_refund`, `409 refund_below_network_fee` (motif aux frais de l'utilisateur, montant ≤ frais ; `details: { refundSats, networkFeeSats }`), `422 refund_cause_not_allowed` (motif impossible pour ce cas ; `details: { allowedCauses: "a,b" }`), `422 refund_address_ours`.

### `POST /api/backoffice/orders/{orderId}/cancel-lines`
Annuler des machines d'une **commande payée** (demande de l'utilisateur, machine défectueuse, souci de stock), remboursées par le même moyen (Bitcoin), **au prorata** de ce qui a été payé (`refund_prorata_sats`, arrondi au sat le plus proche sur le cumul).
```json
{ "lineIds": ["uuid"], "reason": "Machine morte au contrôle", "cause": "shop_defective_machine", "destinationAddress": "bc1q…" }
```
`cause` facultative, parmi `cancelLineCauses` : `shop_stock` (souci de stock, surplus, lot abandonné), `shop_defective_machine`, `admin_other` (défaut), `user_renounce` (annulation **à la demande de l'utilisateur**, à n'importe quelle étape du lot, y compris après la Précommande ; l'admin est tracé dans `refunds[].createdBy`, `initiatedBy: "admin"` ; compte pour le blocage de l'utilisateur sur ce lot). **Frais à la charge de la boutique pour tous ces motifs** (`user_renounce` compris depuis l1) : l'utilisateur reçoit tout le prorata. `lineIds` absent : toutes les machines encore actives ; dans ce cas la commande passe à `refunded`. **L'excédent éventuel ne part jamais avec l'annulation, quelle qu'en soit la cause** (décision Hugo 2026-10-09) : il reste « à traiter » (`admin_decision`), l'admin le rembourse (`POST …/refund`) ou le classe sans suite. → `200 AdminOrder`. `400 invalid_input` (`lineIds` vide : « Cochez au moins une machine » ; `reason` : « Explication obligatoire » ; `cause` : « Choisissez l'un des motifs proposés »), `404 order_not_found`, `409 order_not_paid`, `422 unknown_order_line` (machine d'une autre commande ou déjà remboursée).

**Vente hors chaîne** (refonte R5b) : remboursement **en euros** (`method: "offchain"`), montant = somme des lignes annulées, au plus ce qui reste à rembourser après un rabais (l'annulation des dernières machines rend le reste) ; sans sats, sans frais réseau, sans adresse. Motifs : `shop_stock`, `shop_defective_machine`, `admin_other` (défaut) ; `user_renounce` → `422 refund_cause_not_allowed` (rétractation hors périmètre) ; `destinationAddress` → `422 refund_address_offchain`. Le remboursement est ensuite « à traiter » (`offchain_refund_unsent`) et « à envoyer » jusqu'à son envoi.

### `POST /api/backoffice/orders/{orderId}/discount`
Rabais sur une **commande payée** : des centimes rendus sans annuler de machine (motif `discount`, frais à la charge de la boutique, `initiatedBy: "admin"`).
```json
{ "amount": "10000", "reason": "Rayure sur le capot", "destinationAddress": "bc1q…" }
```
`amount` : centimes (chaîne), **strictement moins** que `refundableAmount` (pour tout rendre, annuler les machines). `reason` obligatoire. Vente hors chaîne : euros rendus, sans adresse (`destinationAddress` → `422 refund_address_offchain`). Facture Bitcoin : sats au prorata de ce qui a été payé (`refund_prorata_sats`), vers l'adresse de la facture ou `destinationAddress`. → `200 AdminOrder` (le rabais est « à envoyer »). Erreurs : `400 invalid_input` (`amount` absent, nul ou mal formé, `reason` vide), `404 order_not_found`, `409 order_not_paid`, `422 discount_too_large` (`details.refundableAmount`), `422 refund_address_offchain`, `422 refund_address_ours`.

### `POST /api/backoffice/orders/{orderId}/dismiss-excess`
« Classer sans suite » les sats reçus non affectés d'une facture quand les rembourser coûterait autant qu'ils valent (`attention.canDismiss`). Journal `OrderExcessDismissal` (append-only) : somme, frais estimés, motif, admin, date.
```json
{ "reason": "Client prévenu, montant inférieur aux frais" }
```
`reason` facultatif (500 caractères au plus, espaces de bord retirés). Sous verrou de la facture (comme les paiements et remboursements) : la somme classée est **tout** `unsettledSats` lu sous ce verrou, jamais un montant envoyé par le client ; les frais viennent du service de paiement. Facture payée, remboursée ou annulée ; somme > 0 et au plus égale aux frais réseau estimés ; **une fois par facture** : un versement arrivé après un classement redevient « à traiter » (rien d'automatique), l'admin le rembourse. Une facture annulée dont des sats sont classés ne peut plus être acceptée.
→ `200 AdminOrder` (`dismissal` renseigné, `unsettledSats` à 0). Erreurs : `400 invalid_input` (motif trop long, champ inconnu), `403 forbidden`, `404 order_not_found`, `409 nothing_to_dismiss` (facture en attente ou expirée, rien de non affecté, ou solde changé entre-temps), `409 excess_already_dismissed` (déjà classée une fois), `409 excess_above_network_fee` (`details: { unsettledSats, networkFeeSats }` : rembourser plutôt). Deux classements simultanés : un seul passe, l'autre `409`.

### `PATCH /api/backoffice/orders/{orderId}/refund-address`
Comme `PATCH /api/orders/{orderId}/refund-address` (adresse obligatoire, jamais effacée), pour n'importe quelle facture ; journalisé avec l'identifiant de l'admin (`actor: "admin"`). → `200 AdminOrder`. `400 invalid_input`, `403 forbidden`, `404 order_not_found`, `409 refund_address_frozen`, `422 refund_address_ours`.

### `GET /api/backoffice/refunds/to-send`
Remboursements créés mais pas encore envoyés, les plus anciens d'abord :
```json
{ "items": [{
  "refundId": "uuid", "method": "bitcoin", "orderId": "uuid", "batch": { "id": "uuid", "name": "10 S19" }, "user": { "id": "uuid", "authUserId": "42" | null }, "contactEmail": "alice@exemple.fr" | null, "profileEmail": "alice@exemple.fr" | null,
  "kind": "overpayment", "cause": "overpayment", "causeLabel": "Excédent de paiement", "initiatedBy": "system",
  "amount": "0", "amountSats": "3000" | null, "networkFeeSats": "2000" | null, "networkFeePayer": "user",
  "destinationAddress": "bc1q…" | null, "destinationSource": "order" | "refund" | null, "addressMissing": false,
  "reason": "Excédent de paiement", "createdAt": "…"
}] }
```
`method` : `bitcoin` (`amountSats` à envoyer à l'adresse) ou `offchain` (vente hors chaîne : `amount`, centimes, à rendre en espèces, par virement… ; `amountSats`, `networkFeeSats` et `destinationAddress` à `null`, `addressMissing: false`). `amount` : centimes remboursés (0 pour un excédent). `amountSats` : à envoyer à l'utilisateur. `destinationAddress` : **adresse effective** (celle choisie pour ce remboursement, `destinationSource: "refund"` ; sinon celle de la facture, `"order"`) ; `addressMissing` : aucune, contacter l'utilisateur. `403 forbidden` hors whitelist.

### `POST /api/backoffice/refunds/{refundId}/send`
Enregistrer l'envoi d'un remboursement, fait par l'admin depuis son portefeuille :
```json
{ "reference": "txid…", "destinationAddress": "bc1q…" }
```
Remboursement hors chaîne (`method: "offchain"`) : `{ "reference": "Espèces rendues, reçu 43" }`, **référence obligatoire, sans adresse** (`destinationAddress` donnée → `422 refund_address_offchain`). Remboursement Bitcoin sans `destinationAddress` : `422 refund_address_missing`.

`destinationAddress` (Bitcoin) : l'adresse **vue et utilisée par l'admin**, recopiée par lui (le serveur ne la recopie jamais). Elle doit être l'adresse effective lue sous verrou de la facture ; sans adresse connue, celle obtenue par contact est inscrite. Un seul envoi (`sent_at` posé par la base, `sentBy` = admin), ensuite tout est figé et l'adresse de remboursement de la facture aussi. → `200 AdminOrder` ; rejoué à l'identique : `200` sans effet. Erreurs : `400 invalid_input` (référence vide, adresse invalide), `403 forbidden`, `404 refund_not_found`, `409 refund_destination_changed` (l'adresse n'est pas, ou plus, la destination : elle a pu changer entre-temps ; relire la liste et confirmer), `409 refund_already_sent` (déjà envoyé avec une autre référence ou adresse), `422 refund_address_ours`.

### `GET /api/backoffice/order-blocks`
Paramètre facultatif `batchId`. Utilisateurs bloqués **maintenant** sur un lot ouvert aux commandes (vue `order_creation_blocks`), les plus récents d'abord ; un blocage échu n'y figure plus :
```json
{ "items": [{ "user": { "id": "uuid", "authUserId": "42" },
              "contactEmail": "bob@exemple.fr" | null, "profileEmail": "bob@exemple.fr" | null,
              "batch": { "id": "uuid", "name": "10 S19", "status": "preorder", "statusLabel": "Précommande" },
              "blockedAt": "…", "blockEndsAt": "…", "abandonedOrders": 3, "lastReleasedAt": null }] }
```
`contactEmail` : e-mail de sa dernière facture sur ce lot (instantané) ; `profileEmail` : e-mail actuel du profil (les deux s'ils diffèrent). `blockEndsAt` : levée automatique. `abandonedOrders` : abandons **et renoncements** comptés depuis la dernière levée de l'admin.

### `POST /api/backoffice/order-block-releases`
« Lever le blocage » avant son échéance automatique : les abandons et renoncements antérieurs de l'utilisateur sur ce lot ne comptent plus (ni plafond ni délai). Journal jamais modifié.
```json
{ "userId": "uuid", "batchId": "uuid", "reason": "Client contacté" }
```
`reason` facultatif. → `201 { "id", "userId", "batchId", "releasedBy": "1", "reason", "createdAt" }`. `404 batch_not_found`, `422 unknown_user`. Une levée sur un utilisateur non bloqué est acceptée (elle efface ses abandons passés sur ce lot).

### Codes des contraintes de la base (dernier rempart)
Si la base refuse malgré les contrôles (course entre deux requêtes), les codes ci-dessus sont repris : `order_priority_window`, `order_priority_quota`, `order_already_pending`, `order_cooldown` (429), `order_creation_blocked`, `order_too_many_lines` (422), `wishlist_withdrawn`, `wishlist_duplicated`, `wishlist_converted`, `order_cancel_paid`, `order_cancel_expired`, `order_status_invalid`, `order_not_paid_in_full`, `order_nothing_received`, `refund_not_allowed`, `refund_below_network_fee`, `order_reservation_running`, `order_not_paid`, `order_renounce_closed`, `refund_address_frozen`, `refund_destination_changed`, `refund_already_sent`, `invalid_refund_address` (422), `refund_address_ours` (422), `refund_address_required` (422), `refund_address_missing` (422), `invalid_refund_reference` (422), `refund_prorata` (422), `refund_overpayment_exceeded` (422), `refund_incomplete` (422), `refund_amount_invalid` (422), `payment_must_be_accepted`, `payment_duplicate`, `out_of_stock`, `option_out_of_stock`, `batch_not_open`, `address_frozen`, `invalid_contact_email` (422), `contact_email_required` (422), `excess_above_network_fee`, `excess_already_dismissed`, `nothing_to_dismiss`, `order_not_acceptable` (facture annulée classée sans suite). Lot de stock, réassorts, transferts : `stock_batch_exists`, `not_stock_batch`, `machine_not_in_batch`, `transfer_from_stock`, `machine_assigned`, `machine_not_in_hand`, `machine_batch_frozen`. Machines : `machine_status_changed`, `machine_transition_not_allowed`, `note_required` (422), `machine_unchanged` (422), `machine_check_not_allowed`, `hashboards_inconsistent` (422), `hashboard_index_out_of_range` (422), `machine_shipped_unassigned`, `mounting_mismatch`, `mounting_machine_status`, `mounting_unknown_value` (422), `mounting_no_kit`, `option_kit_required`, `serial_taken`, `machine_serial_frozen`, `machine_origin`, `line_not_active`, `assignment_batch_status`, `reason_required` (422), `machine_not_assignable`, `machine_already_assigned`, `machine_shipped`, `hashboard_qtt_frozen`. Vente manuelle et paiement hors chaîne (R5b) : `refund_address_offchain` (422, `Order_method_check`), `manual_sale_paid` (`Order_manual_paid`, `Payment_offchain_pending`), `payment_reference_required` (422, `Payment_method_check`, `Payment_reference_check`), `refund_cause_not_allowed` (422, `Refund_method_check`), `nothing_to_dismiss` (`OrderExcessDismissal_bitcoin`) ; `Order_channel_check`, `Order_received_cents_check` sont des règles d'écriture internes (`500`). Les règles d'écriture internes (champs immuables, jamais de suppression, position des lignes, motif/payeur des frais/initiateur cohérents, acteur déclaré pour l'adresse de remboursement, instantané d'e-mail de la facture, journaux append-only du classement et des options retirées) répondent `500 internal` : ce serait un bug du serveur.

## Vente manuelle et paiement hors chaîne (refonte R5a : base de données ; R5b : routes)

Décisions Hugo du 2026-11-11. Code : `src/server/manual-sales.ts` (clients, vente), `src/server/backoffice-orders.ts` (rabais, envoi), `src/server/orders.ts` (`writeRefund` : branche en centimes), `src/server/order-rules.ts` (`checkManualSale`, `OFFCHAIN_REFUND_CAUSES`, `checkDiscount`). Tests : `tests/integration/manual-sales-api.test.ts`.

### Parcours de l'admin (R5c)
1. Taper le pseudo ou l'e-mail du client : `GET /api/backoffice/customers?q=…`. Trouvé : le reprendre (`userId`, adresses enregistrées) ; sinon afficher « Cette personne doit d'abord se connecter une fois à la boutique. » (l'admin ne crée jamais de client). Un compte neuf n'a ni e-mail ni adresse : l'admin saisit `contactEmail` (obligatoire dans ce cas, `422 contact_email_required` sinon) et l'adresse de la vente.
2. `POST /api/backoffice/manual-sales` : lot, machines (options), moyen et référence ; motif, machines et adresse de livraison facultatifs. La facture naît payée.
3. Refus `409 order_creation_blocked` : afficher la date de levée et un bouton « Lever le blocage » (`POST /api/backoffice/order-block-releases` avec `details.userId` et `details.batchId`), puis renvoyer la même vente.
4. Remboursement : `cancel-lines` (machines) ou `discount` (rabais), puis, l'argent rendu, `POST /api/backoffice/refunds/{refundId}/send` avec la référence.

### `GET /api/backoffice/customers?q=…`
Recherche d'un client parmi les **comptes locaux** de la boutique (décision de Hugo du 2026-11-17 ; limite acceptée : la personne doit s'être connectée une fois à la boutique, ce qui crée son compte). Le JWT d'auth-service ne porte que `sub` et `pseudo` : on cherche par `User.pseudo` (enregistré, puis rafraîchi s'il change, à chaque requête connectée) OU par `User.email` (recueilli à la première facture). `q` : au moins 3 caractères, sous-chaîne, casse ignorée ; pseudo ou e-mail identique d'abord, puis plus récents d'abord ; 20 au plus. Aucun compte : liste vide. → `200 { "items": [Customer] }`. `400 invalid_input` (moins de 3 caractères).

**Customer** :
```json
{ "id": "uuid", "authUserId": "42", "pseudo": "henri" | null, "email": "henri@exemple.fr" | null, "createdAt": "…", "addresses": [Address] }
```
Le client a un compte créé par lui-même (ses factures en ligne et manuelles sont visibles sur sa page « Mes commandes »). `addresses` : non archivées, plus récentes d'abord, à reprendre en `{ "addressId" }`.

Il n'existe plus de `POST /api/backoffice/customers` (décision de Hugo du 2026-11-16 : la boutique est 100 % en ligne ; la vente manuelle exige un compte existant, créé par l'utilisateur lui-même). Un `userId` inconnu : `422 unknown_user`.

### `POST /api/backoffice/manual-sales`
```json
{
  "userId": "uuid",
  "batchId": "uuid",
  "lines": [{ "choices": [{ "optionId": "uuid", "optionValueId": "uuid" }] }, {}],
  "machineIds": ["uuid", null],
  "billingAddress": { "addressId": "uuid" },
  "shippingAddress": { "addressId": "uuid" },
  "contactEmail": "henri@exemple.fr",
  "means": "bank_transfer",
  "reference": "VIR-2026-117",
  "reason": "Vente au comptoir"
}
```
- `lines` : une entrée par machine ; un menu non choisi reçoit sa valeur par défaut. **Prix : celui du lot** (prix de revente + options, relus en base, jamais envoyés ; tout champ de prix → `400 invalid_input`). Pas de prix négocié (question ouverte ; un rabais se fait ensuite par `POST …/discount`).
- `machineIds` facultatif : une machine (ou `null`) par ligne, au même rang, attribuée dans la même transaction (mêmes règles que `POST /api/backoffice/order-lines/{lineId}/assignment`). **Lot de stock (R4b) : une ligne sans machine (liste absente ou `null` dans une liste mixte) reçoit d'office une machine vendable libre, hors celles choisies** ; palette : un `null` reste sans machine jusqu'au Contrôle. Machines vendables choisies d'office (prêtes d'abord, puis les plus anciennes reçues), aucune saisie ; absent sur une palette : aucune (attribution au Contrôle, comme en ligne).
- `billingAddress` / `shippingAddress` : `{ "addressId" }` d'une adresse du client, ou une adresse saisie (enregistrée sur le client) ; `shippingAddress` absente : la facturation.
- `contactEmail` facultatif : absent, celui du profil du client ; le profil n'est jamais modifié par une vente manuelle.
- `means` : `cash` (espèces), `bank_transfer` (virement), `other` (autre) ; `reference` libre (n° de virement, reçu), **obligatoire pour `other`** ; tout le total est encaissé par un seul encaissement.
- `reason` facultatif : motif tracé, « Vente au comptoir » par défaut.

→ `201 AdminOrder` : `status: "paid"`, `channel: "manual"`, `paymentMethod: "offchain"`, `manualSale`, `payments[0]` (encaissement, `recordedBy`). **Mêmes règles que la boutique**, formulées pour l'admin, dans l'ordre :

| Code | Cas | `details` |
|---|---|---|
| `400 invalid_input` | entrée invalide ; `reference` absente pour `other` (`issues[].path: "reference"`) ; `machineIds` d'une autre longueur que `lines`, ou machine répétée | |
| `403 forbidden` | hors whitelist | |
| `422 unknown_user` | client inconnu | |
| `404 batch_not_found` | lot inconnu | |
| `409 batch_not_open` | palette hors Précommande–Packaging ; lot de stock en pause (« remettez-le en vente ») | `batchStatus` |
| `409 order_priority_window`, `409 order_priority_quota` | journée de priorité : le client n'a pas (assez) de manifestations d'intérêt | `priorityEndsAt`, `machinesLeft` |
| `409 order_already_pending` | le client a une facture en ligne en attente vivante sur ce lot | `orderId` |
| `409 order_creation_blocked` | client bloqué (abandons, renoncements) : « levez le blocage, puis validez de nouveau la vente » | `blockedAt`, `blockEndsAt`, **`userId`, `batchId`** (corps de `order-block-releases`) |
| `429 order_cooldown` | délai après un abandon | `cooldownEndsAt` |
| `422 order_too_many_lines` | plus de machines que `order_max_lines` | `maxLines` |
| `409 out_of_stock` | stock insuffisant, lignes payées et réservations en ligne comprises (contrôlé au COMMIT : pas de survente entre comptoir et boutique) | `available` |
| `409 option_out_of_stock`, `422 option_not_offered` | option épuisée ou non proposée | |
| `422 contact_email_required`, `422 invalid_contact_email` | aucun e-mail (ni fourni ni au profil), ou mal formé | |
| `422 unknown_address` | `addressId` d'un autre client ou archivée | |
| `409 machine_not_assignable` | machine d'un autre lot, non vendable (dégradée, non contrôlée) | |
| `409 assignment_batch_status` | machine donnée sur une palette avant le Contrôle | |
| `409 machine_already_assigned` | machine prise entre-temps (réessayer) | |

Concurrence : verrous dans l'ordre de la boutique (client, facture, lignes, machines, lot) ; la vente et une commande en ligne simultanées sur la dernière machine : une seule passe.

Visibilité côté boutique : les routes `/api/orders/**` et « Mes commandes » ne lisent que les factures de l'utilisateur connecté (`404 order_not_found` sinon). Le client voit sa vente manuelle (sans `manualSale` ni `recordedBy`) ; il ne peut ni y renoncer (`409 order_renounce_closed`, « conclue avec notre équipe »), ni donner d'adresse de remboursement (`422 refund_address_offchain`).

### Remboursement d'une vente hors chaîne (routes)
- `POST /api/backoffice/orders/{orderId}/cancel-lines` : machines annulées, euros rendus (voir la route).
- `POST /api/backoffice/orders/{orderId}/discount` : rabais en euros.
- « À traiter » (`offchain_refund_unsent`) et « Remboursements à envoyer » (`method: "offchain"`, `amount`) jusqu'à l'envoi : `POST /api/backoffice/refunds/{refundId}/send` avec `{ "reference": "…" }`, sans adresse.
- Sans objet hors chaîne : `POST …/refund` (`409 order_nothing_to_refund`), `POST …/dismiss-excess` (`409 nothing_to_dismiss`), `PATCH …/refund-address` (`422 refund_address_offchain`), `POST …/accept` (`409 order_not_acceptable`).
- Machines en moins (R3a) : une ligne de vente manuelle remboursée par `confirmRefunds` l'est en euros, au même moyen.

### Modèle (R5a)
- Une vente saisie par l'admin est une **facture** (`Order`) comme une autre : `channel = "manual"` (`"online"` pour le tunnel de la boutique), `paymentMethod = "offchain"`, admin (`created_by_auth_user_id`) et motif (`manual_reason`, non vide) tracés et immuables. Canal et moyen sont liés : `online` ⇔ `bitcoin`, `manual` ⇔ `offchain` (`Order_method_check`).
- Facture hors chaîne : ni adresse de paiement, ni montant en sats (`expected_sats`, `payment_address` à `NULL`), ni adresse de remboursement (non requise, interdite) ; montants en **centimes** : `received_cents` (tenu par la base, au plus `total_amount`).
- **Elle naît payée** : écrite par la fonction SQL `create_manual_sale` (ci-dessous), contrôlée au COMMIT (`Order_manual_paid` : jamais en attente, expirée ni annulée).
- **Mêmes règles que la boutique**, sans exception de canal : lot ouvert aux commandes (palette de la Précommande au Packaging, lot de stock en vente), journée de priorité, une facture en attente vivante par client et par lot, délai après abandon, **blocage anti-abus** (l'admin le lève par `POST /api/backoffice/order-block-releases`, tracé, puis vend), `order_max_lines`, stock contrôlé au COMMIT (`Batch_stock`, `BatchOptionValue_max_qty_stock` : pas de survente entre le comptoir et la boutique), e-mail de contact obligatoire (fourni ou celui du profil).
- **Client** : toujours un compte (`User.auth_user_id` obligatoire), créé par l'utilisateur ; e-mail du profil (`User.email`, sert à le retrouver) et adresses (`Address`) comme tout client. Les anciennes contraintes `User_account_check`, `User_created_by_check`, `User_auth_link`, `User_immutable` et la colonne `created_by_auth_user_id` sont supprimées.
- `Payment` et `Refund` portent `method`, **recopié de la facture par la base** (valeur fournie remplacée ; clé étrangère composite vers `Order(id, payment_method)`) : aucun mélange possible.

**Encaissement hors chaîne** (`Payment`, `method = "offchain"`) : `amount_cents` (> 0), `offchain_means` ∈ `cash` (espèces), `bank_transfer` (virement), `other` (autre), `reference` (texte libre non vide : n° de virement, reçu ; **obligatoire pour `other`**), `recorded_by_auth_user_id` (admin) ; ni `amount_sats`, ni `txid`, ni `vout`. Seulement pendant la création de la vente (facture en attente, `Payment_offchain_pending`) ; plusieurs encaissements possibles (espèces + virement) dont la somme fait le total.

**Remboursement hors chaîne** (`Refund`, `method = "offchain"`) : même table, mêmes natures (`cancellation` avec ses lignes, `discount`), même `OrderLine.refund_id`. Décidé par l'admin (`initiatedBy: "admin"`), **en euros seulement** (`amount`, centimes) : au plus ce qui a été reçu (`Order_refunds` ; reçu = total, le prorata est le montant lui-même) ; sans `amountSats`, sans frais réseau (`networkFeePayer: "shop"`), sans adresse. Motifs permis : `shop_stock`, `shop_defective_machine`, `discount`, `admin_other` ; jamais `partial_payment`, `late_payment_no_room`, `overpayment` (propres à la chaîne) ni `user_renounce` (rétractation hors périmètre). Envoi (argent rendu) : comme un remboursement Bitcoin (`reference` libre **obligatoire**, `sent_at` posé par la base, `sent_by_auth_user_id`), sans adresse. Remboursement intégral (`refunded`) : tout ce qui a été reçu est rendu (`Order_refunded_in_full`). Pas de classement sans suite.

**Fonction SQL** `create_manual_sale(p_user, p_batch, p_billing_address, p_shipping_address, p_contact_email, p_configurations uuid[], p_means offchain_means, p_reference, p_reason, p_admin bigint, p_machines uuid[] DEFAULT NULL) → uuid` : dans la transaction de l'appelant, crée la facture (canal `manual`), une ligne par configuration (prix = `configuration_price`, instantané), encaisse tout le total (`Payment` hors chaîne), passe la facture à `paid`, puis attribue les machines données (`p_machines[i]` à la ligne `i`, `NULL` : aucune ; mêmes règles que `POST /api/backoffice/order-lines/{lineId}/assignment` : machine du lot, vendable depuis le stock, palette au Contrôle ou après). Les configurations sont écrites avant par le domaine, comme pour une commande en ligne (`writeConfiguration`). Aucune règle dans la fonction : les triggers s'appliquent.

**Vues**
- `order_payment_balance`, colonnes ajoutées : `payment_method`, `received_cents`, `refunded_cents` (remboursements hors chaîne, envoyés ou non), `unsent_refund_cents`, `offchain_refund_unsent` (un remboursement hors chaîne attend d'être rendu : **« à traiter »**, compris dans `needs_admin_attention`). Facture hors chaîne : colonnes en sats à `0` (`expected_sats` `NULL`), `user_renounce_allowed` faux.
- `refunds_to_send`, colonnes ajoutées : `method`, `amount` (centimes) ; hors chaîne : `amount_sats` et `destination_address` `NULL`, `address_missing` faux. Les remboursements hors chaîne figurent dans « Remboursements à envoyer ».
- `order_creation_blocks` : inchangée, elle couvre aussi les factures de l'admin.

**Contraintes nouvelles** (codes d'API : voir « Codes des contraintes de la base ») : `Order_channel_check`, `Order_method_check`, `Order_received_cents_check`, `Order_manual_paid`, `Payment_method_check`, `Payment_reference_check`, `Payment_offchain_pending`, `Refund_method_check`, `OrderExcessDismissal_bitcoin`. Reprises telles quelles pour une vente manuelle : `Order_batch_open`, `Order_priority_window`, `Order_one_live_per_user_batch`, `Order_abandoned_limit`, `Order_abandoned_cooldown`, `Order_max_lines`, `Order_contact_email_required`, `Batch_stock`, `BatchOptionValue_max_qty_stock`, `OrderLineAssignment_*`, `Order_refunds`, `Refund_sent_check`, `Order_refunded_in_full`.
