# API (jalons 1 à 4 : catalogue, lots, stock des produits d'options, boutique publique, manifestations d'intérêt, factures et paiement)

Contrat pour le frontend. Code : `src/app/api/backoffice/**`, `src/app/api/shop/**`, `src/app/api/wishlists/**`, `src/app/api/orders/**`, `src/app/api/addresses`, `src/app/api/internal/payments` (routes), `src/server/catalog.ts`, `src/server/batches.ts`, `src/server/batch-status.ts` (machine à états, domaine pur), `src/server/batch-settings.ts` (réglages d'options d'un lot, domaine pur), `src/server/part-stock.ts` (stock des produits d'options), `src/server/configurations.ts` (offre d'un lot et configuration complète d'une machine), `src/server/shop.ts` (boutique publique), `src/server/wishlists.ts` (manifestations d'intérêt), `src/server/order-rules.ts` (règles des factures, domaine pur), `src/server/orders.ts` (factures de l'utilisateur), `src/server/payments.ts` (paiements reçus et traitement automatique), `src/server/payment-service.ts` (service de paiement Bitcoin, **simulé**), `src/server/backoffice-orders.ts` (factures au backoffice), `src/server/shop-settings.ts` (réglages `ShopSettings`). Schéma : v5f (`docs/reviews/db-designer-jalon4-2026-10-07.md`).

Les conventions ci-dessous valent pour toutes les routes ; seul l'accès diffère : backoffice (whitelist), boutique publique (sans connexion), manifestations d'intérêt, factures et adresses (utilisateur connecté), paiement interne (secret du service de paiement).

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
→ `200 Option`. `404 option_value_not_found`, `409 option_value_label_taken`, `409 default_value_required` (`isDefault: false` sur le défaut), `409 default_value_withdrawn`, `409 toggle_default_fixed`, `409 option_price_frozen` (`blockers` : lots), `409 default_change_locked`, `422 default_value_not_free`, `422 unknown_part`.

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

Liste (`BatchSummary`) :
```json
{
  "id": "uuid", "name": "10 S19", "status": "preorder", "statusLabel": "Précommande",
  "model": { "id": "uuid", "name": "S19" },
  "quantity": 10, "purchasePrice": "1500000", "resaleUnitPrice": "180000",
  "createdAt": "…", "updatedAt": "…", "priorityEndsAt": null,
  "counters": {
    "paidMachines": 2, "pendingMachines": 1, "orderedMachines": 3, "availableStock": 7,
    "paidOrders": 1, "pendingOrders": 1, "interestedMachines": 4, "interestedUsers": 3,
    "attentionOrders": 0, "blockedUsers": 0
  },
  "transitions": [Transition]
}
```

| Compteur | Sens |
|---|---|
| `paidMachines` | machines payées (lignes non remboursées de commandes payées) |
| `pendingMachines` | machines réservées par une facture en attente encore valide (30 min) |
| `orderedMachines` | payées + réservées : ce qui consomme le stock |
| `availableStock` | `quantity` − commandées − machines sorties du stock (manquantes, rebutées, perdues), fonction SQL `batch_available_stock`. **Non bornée à 0** : une valeur négative signale un lot survendu (impossible après validation en base ; à afficher en alerte si elle apparaît) |
| `paidOrders`, `pendingOrders` | factures payées / en attente valides |
| `interestedMachines`, `interestedUsers` | wishlists actives (une par machine souhaitée) et utilisateurs distincts |
| `attentionOrders` | factures « à traiter » du lot (voir `GET /api/backoffice/orders/attention`) |
| `blockedUsers` | utilisateurs bloqués sur le lot après trop d'abandons (voir `GET /api/backoffice/order-blocks`) |

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
  ]
}
```
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
  "allowed": true, "blockers": [], "warnings": ["Aucune précommande payée : …"]
}
```
`transitions` liste **toutes** les sorties du statut courant, dans l'ordre d'affichage conseillé (la première est l'action principale ; `cancel` en dernier). `allowed: false` : bouton désactivé, `blockers` explique pourquoi. `warnings` : à faire confirmer par l'admin avant l'envoi. `kind` : `forward`, `backward` (correction d'erreur) ou `cancel`. `noteRequired` : un motif est obligatoire (`backward` et `cancel`).

### `GET /api/backoffice/batches`
Paramètres : `status` (liste séparée par des virgules, ex. `status=survey,preorder`), `modelId`, `page` (≥ 1, défaut 1), `pageSize` (1–200, défaut 50). Tri : dernière modification d'abord.
→ `200 { "items": [BatchSummary], "total": 12, "page": 1, "pageSize": 50, "statusCounts": { "draft": 3, "survey": 1, …, "cancelled": 0 } }`. `statusCounts` : nombre de lots par statut (les 11 statuts, 0 compris), filtré par `modelId` mais **pas** par `status` : il alimente les compteurs des filtres en une seule requête. `400 invalid_input` (statut inconnu…).

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
Obligatoires : `modelId`, `quantity` (1–10 000), `purchasePrice` (prix du lot entier, > 0). Facultatifs : `resaleUnitPrice` (prix unitaire de revente, > 0, requis pour publier), `name` (défaut `« {quantité} {modèle} »`), `optionValues`, `hiddenOptions`.

`optionValues` : un réglage par **valeur** d'option du modèle. `enabled` (défaut true), `priceOverride` (défaut null), `maxQty` (défaut null). Une valeur absente hérite du catalogue. La valeur par défaut d'un menu n'est jamais retirée (`409 default_value_withdrawn`) et reste gratuite (dérogation autre que `"0"` : `422 default_value_not_free`).

`hiddenOptions` : identifiants des **menus masqués** sur ce lot (bouton « Masquer ce menu ») ; la valeur par défaut s'y applique d'office, l'utilisateur n'a pas de choix. Liste complète.

Le lot naît au statut `draft` ; la création est la première ligne du journal.
→ `201 Batch`. `422 unknown_model`, `422 unknown_option_value` (valeur d'un autre modèle), `422 unknown_option` (menu masqué inconnu), `409 default_value_withdrawn`, `422 default_value_not_free`.

### `GET /api/backoffice/batches/{batchId}`
→ `200 Batch`. `404 batch_not_found`.

### `PATCH /api/backoffice/batches/{batchId}`
Mêmes champs que la création, tous facultatifs, plus **`expectedUpdatedAt` obligatoire** et `confirmResetChoices` (facultatif, `true`). `optionValues`, s'il est envoyé, est la **liste complète** des réglages (une valeur absente revient au réglage neutre : proposée, prix catalogue, sans limite ; `[]` = tout neutre). `hiddenOptions`, s'il est envoyé, est la liste complète des menus masqués (`[]` = tout afficher).

Écriture ligne par ligne : après la publication, les réglages sont un instantané (une ligne par valeur) qui n'est jamais supprimé ; un réglage neutre est mis à jour, pas effacé. Régler une valeur `not_offered` : `409 option_value_not_offered` (la proposer d'abord).

Lot publié (Sondage) : retirer des valeurs (`enabled: false`) ou réafficher un menu ne doit pas laisser un menu visible avec moins de deux valeurs proposées (menu « choix » sans alternative, ou menu Avec/Sans dont « Avec » est retiré) : `409 menu_without_choice`, rien n'est écrit, message « Le menu « Kit de ventilation » propose moins de deux valeurs sur ce lot : ajoutez une valeur au catalogue, rétablissez une valeur retirée ou masquez le menu. » (plusieurs menus : « Les menus « A », « B » proposent… »). Masquer le menu dans la même requête est permis. En brouillon, la même règle est une condition de publication (pas un refus d'enregistrement).

Masquer un menu (Brouillon, Sondage) ramène au défaut les choix des manifestations d'intérêt dans ce menu ; réafficher leur redonne le défaut (0 €). Si des choix autres que le défaut existent (`wishlistChoices` > 0), la requête est refusée tant que `confirmResetChoices: true` n'est pas envoyé : `409 hidden_menu_has_choices`, message « Masquer ce menu ramènera N choix de manifestation(s) d'intérêt à la valeur par défaut. Confirmez pour continuer. » (à afficher dans la confirmation, puis renvoyer la même requête avec `confirmResetChoices: true`).

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

→ `200 Batch`. `404 batch_not_found`, `409 batch_modified`, `409 batch_field_locked` (le message liste les champs), `409 quantity_below_sold`, `409 max_qty_below_sold`, `409 hidden_menu_has_choices`, `409 menu_without_choice`, `409 option_value_not_offered`, `422 resale_price_required`, `422 unknown_model`, `422 unknown_option_value`, `422 unknown_option`, `409 default_value_withdrawn`, `422 default_value_not_free`.

### `POST /api/backoffice/batches/{batchId}/offered-values`
« Proposer sur ce lot » une valeur ajoutée au catalogue après la publication (`canOffer: true`). Lot de Sondage à En transit.
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

→ `201 Batch` (à jour, avec les nouvelles `transitions`). Erreurs :
| Code | Cas |
|---|---|
| `400 invalid_input` | `from` absent ou inconnu, `to` inconnu |
| `404 batch_not_found` | |
| `409 batch_status_changed` | `from` ≠ statut courant |
| `409 transition_not_allowed` | couple absent de la table (saut d'étape, retour interdit, lot terminé) |
| `422 note_required` | motif manquant pour un retour arrière ou une annulation |
| `409 transition_blocked` | condition métier non remplie ; `message` = les `blockers` |
| `409 batch_has_paid_orders` | annulation avec commande payée (garde de la base) |

**Annulation d'un lot et factures en attente** (décision Hugo 2026-10-09, migration `v5h`) : dans la même transaction, les factures du lot **en attente, sans aucun versement et dont la réservation court encore** passent à `cancelled` (réservation libérée, `cancelledAt` posé par la base) ; le client lit « Lot annulé » (`batch.status: "cancelled"`). **Aucune facture ni adresse de paiement n'est supprimée.** Une facture avec un versement partiel n'est pas touchée : elle reste `pending_payment` et devient « à traiter » (`admin_decision`, lot fermé aux commandes). Un versement reçu ensuite sur l'adresse d'une facture annulée n'est jamais remboursé d'office : « à traiter », l'admin rembourse (`shop_stock`, `admin_other`, `late_payment_no_room`). Les factures déjà expirées sont laissées telles quelles (affichées `expired`). Les factures sont verrouillées avant le lot (même ordre que les paiements) : un paiement validé juste avant l'annulation exclut sa facture. L'avertissement de la transition (`warnings`) annonce ces annulations.
| `422 resale_price_required` | publication sans prix de revente (garde de la base) |

### Machine à états

Statuts : `draft` Brouillon, `survey` Sondage, `preorder` Précommande, `ordering` Commande en cours, `awaiting_reception` Attente de réception, `inspection` Contrôle, `tuning` Tuning, `packaging` Packaging, `in_transit` En transit, `closed` Clôturé, `cancelled` Annulé. Les libellés et la table sont exportés par `src/server/batch-status.ts` (module pur, sans accès base).

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

Aucun retour vers Sondage ou Brouillon une fois la précommande ouverte ; `closed` et `cancelled` sont terminaux. Les conditions sur les machines et les pièces s'appuient sur des données saisies aux jalons 5 et 6 : d'ici là, un lot s'arrête à « Attente de réception ».

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

Sans connexion. Lots visibles : **Sondage, puis Précommande à Packaging** (fonction SQL `batch_is_public`, source unique avec la base : un lot en transit, clôturé ou annulé n'est plus public). Un lot en brouillon, à un autre statut ou inconnu donne `404 batch_not_found`, comme un identifiant mal formé. Jamais exposés : prix d'achat, quantité achetée, compteurs, réglages internes (dérogations en tant que telles, valeurs retirées, menus masqués), journal.

### Objet `PublicBatch`
```json
{
  "id": "uuid", "name": "10 S19", "status": "survey", "statusLabel": "Sondage",
  "model": { "id": "uuid", "name": "S19", "hashrate": "95000000000000", "description": "Antminer S19 95 TH/s" },
  "availableQuantity": 10,
  "resaleUnitPrice": "180000",
  "acceptsOrders": false,
  "priorityEndsAt": null
}
```
`acceptsOrders` : le lot accepte des factures (Précommande à Packaging, fonction SQL `batch_accepts_orders`). `priorityEndsAt` : fin de la journée de priorité (réservée aux personnes ayant manifesté leur intérêt, dans la limite de leurs machines souhaitées), `null` s'il n'y en a pas ; peut être passée (comparer à l'heure courante). `name` : nom du lot, **toujours renseigné** (colonne obligatoire) : le nom choisi par l'admin, sinon le nom par défaut « {quantité} {modèle} » posé à la création et tenu à jour tant qu'il n'est pas personnalisé. `availableQuantity` : machines encore disponibles (`batch_available_stock`, jamais négatif à l'affichage ; au sondage = quantité du lot). `resaleUnitPrice` : prix de la machine nue, centimes.

### `GET /api/shop/batches`
→ `200 { "items": [PublicBatch] }`, du plus récent au plus ancien.

### `GET /api/shop/batches/{batchId}`
Fiche produit : `PublicBatch` plus les options proposées par le lot.
```json
{
  "…": "champs de PublicBatch",
  "wishlistLimit": 5,
  "maxMachinesPerOrder": 10,
  "options": [{
    "id": "uuid", "kind": "choice", "title": "Kit de ventilation", "description": null, "position": 0,
    "values": [
      { "id": "uuid", "label": "Sans kit", "isDefault": true, "position": 0, "price": "0", "maxQty": null },
      { "id": "uuid", "label": "Silent kit", "isDefault": false, "position": 1, "price": "6000", "maxQty": 3 }
    ]
  }]
}
```
`wishlistLimit` : plafond effectif de manifestations d'intérêt actives **par utilisateur** sur ce lot (le même pour tous) : réglage `ShopSettings.wishlist_max_per_user_per_batch` (défaut 5, imposé par la base), jamais plus que la quantité du lot. `maxMachinesPerOrder` : machines au plus par facture (`ShopSettings.order_max_lines`, défaut 10) (voir `POST /api/wishlists`). Pour afficher ce qui reste à un utilisateur connecté : `wishlistLimit` − nombre de ses wishlists du lot (`GET /api/wishlists?batchId=…`).

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
  "outdated": false
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
| `items[].offered` | le lot propose encore cette valeur (`batch_offered_values`) ; `false` : option retirée depuis, le prix affiché n'est plus d'actualité et une commande de cette machine serait refusée (`422 option_not_offered`) |
| `outdated` | au moins un `items[].offered` est faux : à signaler à l'utilisateur (modifier la configuration tant qu'elle est `editable` ; sinon retirer la machine et en choisir une autre) |
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

## Factures : précommande et commande (jalon 4)

Utilisateur connecté. **Une facture** = un utilisateur, un lot, **une ligne par machine** (configuration complète), payée **en totalité** en Bitcoin sur une adresse qui lui est propre (jamais réutilisée). Précommande, ou commande simple si le lot était en Tuning ou Packaging à la création (`kind`). Une facture n'est **jamais supprimée** : elle est annulée, expire ou est remboursée. Chacun ne voit que ses factures : celle d'un autre répond `404 order_not_found`, comme une facture inconnue.

Règles (imposées par la base, vérifiées avant par le serveur pour un message daté) :
- **Lot ouvert aux commandes** : Précommande à Packaging inclus. Sondage : « pas encore ouvertes » ; En transit, clôturé, annulé : refusé (`409 batch_not_open`).
- **Journée de priorité** (lot passé par le sondage, avec au moins une wishlist active) : pendant 1 jour après l'ouverture des précommandes, seules les personnes ayant une wishlist active commandent, **dans la limite du nombre de leurs wishlists** (machines déjà prises comprises). Elle se termine plus tôt quand toutes les wishlists actives sont converties (lignes payées qui les référencent : envoyez `wishlistId` sur les lignes qui en viennent, sinon la journée ne se termine pas plus tôt).
- **Une seule facture en attente vivante** par utilisateur et par lot.
- **Réservation de 30 min** à partir de la création (le stock est réservé, l'appoint ne la prolonge pas). Passé ce délai la facture s'affiche `expired` et libère sa place ; un paiement complet reçu ensuite est accepté s'il reste de la place, sinon remboursé.
- **Abandons** (facture annulée, expirée sans paiement complet, ou remboursée avant paiement complet), par utilisateur et par lot : **délai** de 5 min après chaque abandon (`429 order_cooldown` + `Retry-After`) ; au **3e abandon en 24 h**, **blocage** sur ce lot jusqu'à ce que l'admin le lève (`409 order_creation_blocked`). Valeurs : `ShopSettings`.
- **10 machines au plus par facture** (`ShopSettings.order_max_lines`).
- **Prix** : jamais envoyés par le client, relus en base (prix de revente du lot, prix effectif des options), figés dans la facture. Montant attendu en sats calculé au taux du service de paiement au moment de la création, arrondi au sat supérieur, figé.

### Objet `Order`
```json
{
  "id": "uuid", "status": "pending_payment", "statusLabel": "En attente de paiement",
  "kind": "preorder", "kindLabel": "Précommande",
  "createdAt": "…", "expiresAt": "…", "paidAt": null, "cancelledAt": null, "refundedAt": null,
  "batch": { "id": "uuid", "name": "10 S19", "status": "preorder", "statusLabel": "Précommande",
             "isPublic": true, "acceptsOrders": true, "model": { "id": "uuid", "name": "S19" } },
  "totalAmount": "107500",
  "payment": { "method": "bitcoin", "address": "bcrt1q…", "expectedSats": "1194445", "receivedSats": "0",
               "outstandingSats": "1194445", "refundedSats": "0", "underReviewSats": "0" },
  "refundAddress": "bc1q…" | null,
  "lines": [{ "id": "uuid", "position": 1, "amount": "57500", "basePrice": "50000", "wishlistId": "uuid" | null, "refunded": false,
              "items": [{ "optionId": "uuid", "optionTitle": "Kit de ventilation", "optionValueId": "uuid", "label": "Silent kit", "isDefault": false, "unitPrice": "7500" }] }],
  "payments": [{ "id": "uuid", "amountSats": "1194445", "txid": "…", "vout": 0, "receivedAt": "…" }],
  "refunds": [{ "id": "uuid", "kind": "cancellation", "kindLabel": "Annulation",
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
| `status` | `pending_payment` (en attente), `paid` (payée), `expired` (réservation passée sans paiement complet ; **affiché** dès `expiresAt` dépassé, même si la base n'a pas encore écrit le statut), `refunded` (tout ce qui a été reçu est remboursé), `cancelled` (annulée par l'utilisateur, ou **avec le lot** quand il est annulé et que rien n'avait été reçu : `batch.status: "cancelled"`) |
| `kind` | `preorder` (Précommande) ou `order` (Commande : lot en Tuning ou Packaging à la création) |
| `payment.address` | adresse Bitcoin de la facture : l'utilisateur y paie `expectedSats`, en une ou plusieurs fois. Simulée au jalon 4 : préfixe `bcrt1q` (réseau de test, jamais une adresse réelle) |
| `payment.outstandingSats` | appoint attendu (facture en attente ou expirée), 0 sinon |
| `payment.refundedSats` | sats sortis du solde par les remboursements (frais réseau à la charge de l'utilisateur compris) |
| `payment.underReviewSats` | sats reçus que l'**équipe** doit encore traiter (« à traiter » au backoffice) : excédent d'une facture payée (quel qu'en soit le montant, voir ci-dessous), paiement arrivé après un remboursement intégral ou une annulation (lot annulé compris), ou sur un lot qui n'accepte plus de commande. `"0"` : rien. Aucun remboursement automatique : l'équipe contacte la personne. À afficher (« votre versement est traité par notre équipe ») au lieu d'un statut muet |
| `refundAddress` | adresse Bitcoin où rembourser, donnée par l'utilisateur (création, `PATCH …/refund-address`, remboursement du versement) ou par l'admin ; `null` : pas encore donnée (un remboursement à envoyer est alors « à traiter », l'admin contacte la personne). Modifiable tant qu'aucun remboursement de la facture n'est envoyé |
| `lines` | une par machine, **dans l'ordre de la requête de création** : `position` 1, 2, 3… (posée par la base, « Machine 1, 2… »). `refunded` : machine annulée et remboursée |
| `refunds[].kind` | `cancellation` (machines annulées), `discount` (rabais), `overpayment` (excédent, `amount` = 0) |
| `refunds[].cause` | motif, qui fixe **qui paie les frais réseau** (règle unique en base, `refund_cause_fee_payer`) : boutique pour `shop_stock` (stock, surplus, lot abandonné), `shop_defective_machine`, `late_payment_no_room`, `discount`, `admin_other` ; utilisateur pour `user_renounce`, `partial_payment`, `overpayment`. `causeLabel` : libellé français |
| `refunds[].initiatedBy` | `user` (renoncement, remboursement du versement), `admin`, `system` (traitement automatique) |
| `refunds[].networkFeePayer` | `shop` (frais tracés, jamais déduits) ou `user` (frais déduits : `amountSats` = brut − frais) |
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
  "refundAddress": "bc1q…"
}
```
- `lines` : une entrée par machine (1 à 1 000 dans la requête ; plafond métier : `maxMachinesPerOrder`). `wishlistId` : reprend la configuration d'une de **ses** manifestations d'intérêt du lot (active, non convertie) et la référence ; `choices` : choix libres (un menu non choisi reçoit son défaut) ; `{}` : tous les défauts. Pas les deux sur une même ligne ; une wishlist au plus une fois.
- `billingAddress` / `shippingAddress` : une adresse saisie (`fullName`, `line1`, `postalCode`, `city` obligatoires ; `country` code ISO à deux lettres, mis en majuscules) ou `{ "addressId" }` d'une adresse enregistrée (`GET /api/addresses`). Une adresse saisie identique à une adresse enregistrée est reprise. `shippingAddress` absente : même adresse que la facturation.
- `refundAddress` : facultative (ou `null`), adresse Bitcoin où rembourser si besoin ; journalisée avec son auteur.
- Aucun prix ni montant en entrée (`400 invalid_input`).

→ `201 Order`. Erreurs, dans l'ordre des contrôles :

| Code | Cas | `details` |
|---|---|---|
| `400 invalid_input` | entrée invalide, wishlist commandée deux fois, ligne avec `wishlistId` et `choices` | |
| `401 unauthenticated` | | |
| `404 batch_not_found` | lot inconnu ou en brouillon | |
| `409 batch_not_open` | lot au sondage (« pas encore ouvertes »), en transit, clôturé, annulé | `batchStatus` |
| `409 order_priority_window` | journée de priorité, aucune machine permise (pas de wishlist, ou quota pris) ; le message donne la fin (« jusqu'au 8 octobre à 10:30 ») | `priorityEndsAt`, `machinesLeft: 0` |
| `409 order_already_pending` | une facture en attente vivante existe déjà sur ce lot | `orderId` |
| `409 order_creation_blocked` | bloqué sur ce lot après trop d'abandons : « contactez-nous » | `blockedAt` |
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

Concurrence : les créations d'un même utilisateur se suivent (verrou de l'utilisateur) ; le stock est contrôlé sous verrou du lot au COMMIT : 4 clients pour 2 places, 2 factures.

### `GET /api/orders`
Paramètre facultatif `batchId`. → `200 { "items": [Order] }`, de la plus récente à la plus ancienne (toutes, annulées et remboursées comprises).

### `GET /api/orders/{orderId}`
→ `200 Order`. `404 order_not_found`.

### `GET /api/orders/eligibility?batchId=uuid`
Ce que l'utilisateur peut commander maintenant sur le lot, pour afficher les messages **avant** l'envoi (l'UI n'empêche rien : `POST /api/orders` tranche).
```json
{
  "batchId": "uuid", "batchStatus": "preorder", "acceptsOrders": true,
  "priorityEndsAt": "2026-10-08T08:30:00.000Z", "priorityMachinesLeft": 2,
  "pendingOrderId": null, "blockedAt": null, "cooldownEndsAt": null,
  "availableQuantity": 7, "maxMachinesPerOrder": 10,
  "wishlistIds": ["uuid", "uuid"],
  "refusal": null
}
```
`priorityMachinesLeft` : machines encore permises en priorité (« vous pouvez encore prendre N machines »), `null` hors journée de priorité. `wishlistIds` : ses wishlists actives non converties sur ce lot, à reprendre en `lines[].wishlistId`. `refusal` : `{ code, message, details }` qu'aurait une facture d'une machine maintenant, `null` sinon. → `200`. `400 invalid_input` (`batchId` absent ou mal formé), `404 batch_not_found` (inconnu ou brouillon).

### `POST /api/orders/{orderId}/cancel`
Corps `{}`. Annule une facture **en attente, rien reçu, réservation vivante** : la place est libérée tout de suite. C'est un abandon (délai, plafond). Rejouée sur une facture déjà annulée : `200` sans effet.
→ `200 Order` (`status: "cancelled"`, `cancelledAt` posé par la base). `404 order_not_found`, `409 order_cancel_paid` (un paiement a été reçu : demander le remboursement du versement ou compléter), `409 order_cancel_expired` (déjà expirée), `409 order_not_cancellable` (payée, remboursée).

Un paiement qui arrive sur une facture annulée n'est jamais refusé : la facture devient « à traiter » au backoffice.

### `POST /api/orders/{orderId}/refund`
Remboursement du **versement partiel** (avant comme après l'expiration), **frais réseau à la charge de l'utilisateur** (estimés par le service de paiement, déduits de ce qu'il reçoit ; motif `partial_payment`). Une transaction : remboursement de toutes les machines, facture remboursée. C'est un abandon (délai, plafond).
```json
{ "refundAddress": "bc1q…" }
```
`refundAddress` facultative : si elle est donnée, elle est **écrite sur la facture** (`refundAddress`, journalisée comme un `PATCH`) ; sinon celle de la facture s'applique ; sans aucune, l'admin contacte l'utilisateur avant l'envoi. Le remboursement lui-même n'a pas d'adresse propre (`destinationAddress: null`).
→ `200 Order` (`status: "refunded"`, `refunds[0]` : `cause: "partial_payment"`, `initiatedBy: "user"`, `networkFeePayer: "user"`, `amountSats` = reçu − frais). Erreurs : `400 invalid_input` (adresse Bitcoin attendue), `404 order_not_found`, `409 order_nothing_received` (rien reçu : annuler plutôt), `409 refund_below_network_fee` (le versement ne couvre pas les frais : compléter le paiement ; `details: { receivedSats, networkFeeSats }`), `409 refund_not_allowed` (paiement complet, facture payée ou annulée, lot fermé aux commandes : la boutique s'en charge), `409 order_already_refunded`, `422 refund_address_ours`.

### `PATCH /api/orders/{orderId}/refund-address`
Donner, changer ou effacer (`null`) l'adresse de remboursement d'une de **ses** factures, tant qu'aucun remboursement de la facture n'est envoyé. Chaque changement est journalisé avec son auteur (lisible au backoffice).
```json
{ "refundAddress": "bc1q…" | null }
```
→ `200 Order`. Erreurs : `400 invalid_input` (adresse Bitcoin attendue, champ absent), `401 unauthenticated`, `404 order_not_found` (inconnue ou d'un autre), `409 refund_address_frozen` (un remboursement est déjà envoyé : « contactez-nous »), `422 refund_address_ours` (adresse de paiement de la boutique).

Concurrence : le changement et l'envoi d'un remboursement prennent le même verrou (la facture). Un envoi validé d'abord fait échouer le changement (`409 refund_address_frozen`) ; un changement validé d'abord fait échouer l'envoi vers l'ancienne adresse (`409 refund_destination_changed` côté admin).

### `POST /api/orders/{orderId}/renounce`
Renoncer à des machines d'une **commande payée** (ou à toute la commande), **tant que le lot est au plus en Précommande** (après : `409 order_renounce_closed`, « contactez-nous » ; l'admin peut alors annuler à sa demande par `cancel-lines` avec `cause: "user_renounce"`, frais toujours à sa charge). Remboursement au prorata de ce qui a été payé (arrondi au sat le plus proche sur le cumul), **frais réseau à la charge de l'utilisateur** (motif `user_renounce`), vers l'adresse de la facture (`refundAddress`, à donner par `PATCH …/refund-address` si elle manque). Toute la commande : elle passe à `refunded`, et l'excédent de paiement encore non remboursé part dans le même envoi, sans nouveaux frais (deuxième remboursement `overpayment`, `networkFeeSats: "0"`). Ce n'est pas un abandon (ni délai ni blocage).
```json
{ "lineIds": ["uuid"] }
```
`lineIds` facultatif (absent : toutes les machines encore actives). → `200 Order`. Erreurs : `400 invalid_input`, `401 unauthenticated`, `404 order_not_found` (inconnue ou d'un autre), `409 order_not_paid` (facture non payée ou déjà remboursée), `409 order_renounce_closed` (lot au-delà de la Précommande), `409 refund_below_network_fee` (le prorata ne couvre pas les frais ; `details: { refundSats, networkFeeSats }`), `422 unknown_order_line` (machine d'une autre commande ou déjà remboursée).

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
{ "user": { "id": "uuid", "authUserId": "42" }, "unsettledSats": "0", "refundDueSats": "0", "abandonedAt": null,
  "attention": null | { "reason": "admin_decision", "label": "…", "canAccept": true, "canRefund": true,
                        "refundCauses": [{ "cause": "admin_other", "label": "Autre décision de la boutique", "networkFeePayer": "shop" }] },
  "cancelLineCauses": [{ "cause": "shop_stock", "label": "Souci de stock (surplus, lot abandonné)", "networkFeePayer": "shop" }],
  "refundAddressChanges": [{ "id": "uuid", "oldAddress": null, "newAddress": "bc1q…", "actor": "user", "actorAuthUserId": "42", "createdAt": "…" }] }
```
- `unsettledSats` : sats reçus non affectés (ni acceptés pour la marchandise, ni remboursés). `refundDueSats` : excédent d'une facture payée à rembourser. `abandonedAt` : date de l'abandon compté (délai, plafond).
- `refunds[]` porte en plus `createdBy` (admin qui l'a décidé, sinon `null`) et `sentBy` (admin qui a enregistré l'envoi ; `null` : pas envoyé ou envoyé par le service de paiement).
- `attention.refundCauses` : motifs proposés pour « Rembourser » (vide si rien à rembourser), avec le payeur des frais qui en découle.
- `cancelLineCauses` : motifs de `cancel-lines` (commande payée : `shop_stock`, `shop_defective_machine`, `user_renounce`, `admin_other`), sinon vide.
- `user_renounce` ne figure jamais dans `attention.refundCauses` : une annulation à la demande de l'utilisateur passe par `cancel-lines` (le reliquat d'excédent d'un renoncement n'existe qu'avec l'annulation de toute la commande).
- `refundAddressChanges` : journal **en lecture seule** des changements d'adresse de remboursement (saisie, modification, effacement ; auteur `user` ou `admin`), du plus ancien au plus récent.

### `GET /api/backoffice/orders/attention`
« À traiter », les plus anciennes d'abord :
```json
{ "items": [{
  "orderId": "uuid", "batch": { "id": "uuid", "name": "10 S19", "status": "preorder", "statusLabel": "Précommande" },
  "user": { "id": "uuid", "authUserId": "42" }, "status": "cancelled", "statusLabel": "Annulée", "createdAt": "…",
  "machines": 1, "totalAmount": "50000", "expectedSats": "555556", "receivedSats": "555556", "refundedSats": "0",
  "unsettledSats": "555556", "outstandingSats": "0",
  "attention": { "reason": "admin_decision", "label": "Paiement complet reçu après l'annulation : accepter la commande s'il reste de la place, sinon rembourser.", "canAccept": true, "canRefund": true }
}] }
```
| `attention.reason` | Cas | Actions |
|---|---|---|
| `admin_decision` | paiement reçu après une annulation, après un remboursement intégral, ou sur une facture impayée d'un lot fermé aux commandes | rembourser ; accepter si annulée, payée intégralement et lot ouvert |
| `user_decision` | facture expirée partiellement payée : **contacter l'utilisateur** (appoint ou remboursement de son versement, frais à sa charge). Sans réponse : l'admin la rembourse (motif `partial_payment`, frais à la charge de l'utilisateur, motif écrit obligatoire) | rembourser |
| `awaiting_decision` | paiement complet resté sans traitement automatique. Le libellé dit s'il ne tient plus dans le stock (`fits_stock`) : réservation encore vivante → « Accepter » répond `409 out_of_stock` jusqu'à la fin de la réservation, puis rembourse | accepter |
| `overpayment_decision` | facture payée dont l'excédent n'est pas remboursé (aucun excédent n'est remboursé d'office, quel qu'en soit le montant) : contacter le client, puis décider | rembourser (`admin_other` : frais boutique, ou `overpayment` : frais utilisateur, **proposé seulement si l'excédent dépasse les frais**), ou attendre |
| `refund_address_missing` | un remboursement à envoyer n'a pas d'adresse : contacter l'utilisateur, puis `PATCH …/refund-address` ou envoyer vers l'adresse obtenue | aucune |

Motifs permis par cas pour « Rembourser » (`attention.refundCauses`) :

| Cas | Nature | Motifs |
|---|---|---|
| `user_decision` (réservation terminée) | annulation de toutes les machines | `partial_payment` (frais utilisateur), `admin_other` |
| `overpayment_decision` | excédent | `admin_other`, `overpayment` (frais utilisateur) |
| paiement reçu après un remboursement intégral | excédent | `overpayment` (frais utilisateur), `admin_other` |
| facture annulée, ou impayée d'un lot fermé | annulation de toutes les machines | `admin_other`, `shop_stock` (lot abandonné compris), `late_payment_no_room` si le paiement est complet |

Un motif dont les **frais sont à la charge de l'utilisateur** (`overpayment`, `partial_payment`) n'est **pas proposé** quand la somme à rembourser ne couvre pas les frais réseau (`unsettledSats` ≤ frais) : seul le motif aux frais de la boutique reste (le serveur refuserait l'autre, `409 refund_below_network_fee`).

### `GET /api/backoffice/orders/{orderId}`
→ `200 AdminOrder` (adresses, paiements, remboursements). `404 order_not_found`.

### `GET /api/backoffice/batches/{batchId}/orders`
→ `200 { "items": [AdminOrder] }` : toutes les factures du lot, de la plus récente à la plus ancienne. `404 batch_not_found`.

### `POST /api/backoffice/orders/{orderId}/accept`
Corps `{}`. Accepter une facture « à traiter » (`attention.canAccept`) : payée s'il reste de la place (contrôle sous verrou du lot) ; un excédent éventuel reste « à traiter » (aucun excédent n'est remboursé d'office). Paiement complet resté sans traitement, plus de place : remboursé intégralement si la réservation est terminée (`late_payment_no_room`, frais boutique). → `200 AdminOrder`. `404 order_not_found`, `409 order_not_acceptable`, `409 out_of_stock` (facture annulée sans place : la rembourser ; réservation encore vivante qui ne tient plus : rien n'est fait, `details: { expiresAt }`), `409 batch_not_open`.

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
`cause` facultative, parmi `cancelLineCauses` : `shop_stock` (souci de stock, surplus, lot abandonné), `shop_defective_machine`, `admin_other` (défaut), frais à la charge de la boutique ; `user_renounce` (annulation **à la demande de l'utilisateur**, à n'importe quelle étape du lot, y compris après la Précommande), **frais à la charge de l'utilisateur** (il reçoit le prorata moins les frais ; l'admin est tracé dans `refunds[].createdBy`, `initiatedBy: "admin"`). `lineIds` absent : toutes les machines encore actives ; dans ce cas la commande passe à `refunded`, avec l'excédent encore non remboursé (même motif, sans frais : un seul envoi). → `200 AdminOrder`. `400 invalid_input` (`lineIds` vide : « Cochez au moins une machine » ; `reason` : « Explication obligatoire » ; `cause` : « Choisissez l'un des motifs proposés »), `404 order_not_found`, `409 order_not_paid`, `409 refund_below_network_fee` (`user_renounce` : le prorata ne couvre pas les frais ; `details: { refundSats, networkFeeSats }`), `422 unknown_order_line` (machine d'une autre commande ou déjà remboursée).

### `PATCH /api/backoffice/orders/{orderId}/refund-address`
Comme `PATCH /api/orders/{orderId}/refund-address`, pour n'importe quelle facture ; journalisé avec l'identifiant de l'admin (`actor: "admin"`). → `200 AdminOrder`. `400 invalid_input`, `403 forbidden`, `404 order_not_found`, `409 refund_address_frozen`, `422 refund_address_ours`.

### `GET /api/backoffice/refunds/to-send`
Remboursements créés mais pas encore envoyés, les plus anciens d'abord :
```json
{ "items": [{
  "refundId": "uuid", "orderId": "uuid", "batch": { "id": "uuid", "name": "10 S19" }, "user": { "id": "uuid", "authUserId": "42" },
  "kind": "overpayment", "cause": "overpayment", "causeLabel": "Excédent de paiement", "initiatedBy": "system",
  "amountSats": "3000", "networkFeeSats": "2000", "networkFeePayer": "user",
  "destinationAddress": "bc1q…" | null, "destinationSource": "order" | "refund" | null, "addressMissing": false,
  "reason": "Excédent de paiement", "createdAt": "…"
}] }
```
`amountSats` : à envoyer à l'utilisateur. `destinationAddress` : **adresse effective** (celle choisie pour ce remboursement, `destinationSource: "refund"` ; sinon celle de la facture, `"order"`) ; `addressMissing` : aucune, contacter l'utilisateur. `403 forbidden` hors whitelist.

### `POST /api/backoffice/refunds/{refundId}/send`
Enregistrer l'envoi d'un remboursement, fait par l'admin depuis son portefeuille :
```json
{ "reference": "txid…", "destinationAddress": "bc1q…" }
```
`destinationAddress` : l'adresse **vue et utilisée par l'admin**, recopiée par lui (le serveur ne la recopie jamais). Elle doit être l'adresse effective lue sous verrou de la facture ; sans adresse connue, celle obtenue par contact est inscrite. Un seul envoi (`sent_at` posé par la base, `sentBy` = admin), ensuite tout est figé et l'adresse de remboursement de la facture aussi. → `200 AdminOrder` ; rejoué à l'identique : `200` sans effet. Erreurs : `400 invalid_input` (référence vide, adresse invalide), `403 forbidden`, `404 refund_not_found`, `409 refund_destination_changed` (l'adresse n'est pas, ou plus, la destination : elle a pu changer entre-temps ; relire la liste et confirmer), `409 refund_already_sent` (déjà envoyé avec une autre référence ou adresse), `422 refund_address_ours`.

### `GET /api/backoffice/order-blocks`
Paramètre facultatif `batchId`. Utilisateurs bloqués sur un lot ouvert aux commandes (vue `order_creation_blocks`), les plus récents d'abord :
```json
{ "items": [{ "user": { "id": "uuid", "authUserId": "42" }, "batch": { "id": "uuid", "name": "10 S19", "status": "preorder", "statusLabel": "Précommande" },
              "blockedAt": "…", "abandonedOrders": 3, "lastReleasedAt": null }] }
```

### `POST /api/backoffice/order-block-releases`
« Lever le blocage » : les abandons antérieurs de l'utilisateur sur ce lot ne comptent plus (ni plafond ni délai). Journal jamais modifié.
```json
{ "userId": "uuid", "batchId": "uuid", "reason": "Client contacté" }
```
`reason` facultatif. → `201 { "id", "userId", "batchId", "releasedBy": "1", "reason", "createdAt" }`. `404 batch_not_found`, `422 unknown_user`. Une levée sur un utilisateur non bloqué est acceptée (elle efface ses abandons passés sur ce lot).

### Codes des contraintes de la base (dernier rempart)
Si la base refuse malgré les contrôles (course entre deux requêtes), les codes ci-dessus sont repris : `order_priority_window`, `order_priority_quota`, `order_already_pending`, `order_cooldown` (429), `order_creation_blocked`, `order_too_many_lines` (422), `wishlist_withdrawn`, `wishlist_duplicated`, `wishlist_converted`, `order_cancel_paid`, `order_cancel_expired`, `order_status_invalid`, `order_not_paid_in_full`, `order_nothing_received`, `refund_not_allowed`, `refund_below_network_fee`, `order_reservation_running`, `order_not_paid`, `order_renounce_closed`, `refund_address_frozen`, `refund_destination_changed`, `refund_already_sent`, `invalid_refund_address` (422), `refund_address_ours` (422), `refund_address_missing` (422), `invalid_refund_reference` (422), `refund_prorata` (422), `refund_overpayment_exceeded` (422), `refund_incomplete` (422), `refund_amount_invalid` (422), `payment_must_be_accepted`, `payment_duplicate`, `out_of_stock`, `option_out_of_stock`, `batch_not_open`, `address_frozen`. Les règles d'écriture internes (champs immuables, jamais de suppression, position des lignes, motif/payeur des frais/initiateur cohérents, acteur déclaré pour l'adresse de remboursement) répondent `500 internal` : ce serait un bug du serveur.
