# Contrat shop ↔ bitcoin-service (paiement Bitcoin)

Statut : **proposition à valider** (rédigée le 2026-11-23 ; base = cluster Postgres HA et Prisma, alertes par les logs : décisions Hugo 2026-11-23). Remplace `SimulatedPaymentService` (`src/server/payment-service.ts`) par un client du vrai service, sans changer l'interface `PaymentService` ni la route entrante `POST /api/internal/payments`.

## 1. Périmètre et séparation des responsabilités

`bitcoin-service` se comporte comme un service tiers type nœud / BTCPay : il connaît les adresses, les transactions et les confirmations, **rien du métier**. Le shop connaît les factures, les lots et les remboursements, **rien de la chaîne**.

| Responsabilité | bitcoin-service | shop |
|---|---|---|
| Dériver une adresse de réception par facture (xpub) | oui | non |
| Taux BTC/EUR au moment de la facture, calcul des sats attendus | oui | non (il fige le résultat) |
| Surveiller la chaîne, compter les confirmations | oui | non |
| Notifier un paiement (webhook) avec réessais | oui | non |
| Règles métier : accepté, partiel, excédent, expiré, remboursement | non | oui |
| Envoyer un remboursement | **non** (service watch-only, aucune clé privée) | admin, hors service (`POST /api/backoffice/refunds/{id}/send` enregistre l'envoi) |

Conséquences : le service ne connaît ni `orderId` métier au-delà d'une étiquette opaque, ni délais d'expiration, ni statuts. Il notifie **chaque sortie (txid, vout) reçue sur une adresse qu'il a émise**, point.

## 2. Décisions à entériner

1. **Watch-only** : le service ne détient qu'une xpub. Les remboursements restent manuels (déjà le cas côté shop : l'admin envoie et enregistre `sentAt` + `reference`).
2. **Pas de seuil de confirmations dans le shop** : le service décide quand notifier (§5.3). Le shop traite chaque notification comme un paiement définitif (il n'a pas de route d'annulation).
3. **Le service possède le taux** (réutilise `/bitcoin-price`). Le shop ne lit plus `PAYMENT_BTC_PRICE_EUR_CENTS` en production (reste utilisable avec le service simulé).
4. **Adresse jamais réutilisée**, une facture = un index de dérivation. Appel `POST /invoices` idempotent sur `orderId`.

## 3. Modèle côté bitcoin-service

Base : **cluster Postgres HA existant** (base et rôle dédiés au service, pas de schéma partagé avec le shop). ORM : **Prisma** (§6.5). Le service est aujourd'hui sans état ; il en a désormais un.

Le schéma ci-dessous est la forme logique ; le fichier `prisma/schema.prisma` fait foi. Montants en `BigInt`, dates en `timestamptz`. `derivation_index` vient d'une **séquence Postgres** (`autoincrement()` sur une colonne dédiée) : l'unicité tient sans verrou applicatif, même avec plusieurs instances.

```
invoice
  id                uuid pk
  order_id          text unique       -- étiquette opaque fournie par le shop
  derivation_index  int unique        -- chemin 0/<index> sous la xpub
  address           text unique
  amount_cents      bigint            -- montant demandé
  btc_price_eur_cents bigint          -- taux figé
  expected_sats     bigint
  created_at        timestamptz

received_output                        -- une ligne par (txid, vout) vue sur une de nos adresses
  txid, vout        pk
  address           fk invoice.address
  amount_sats       bigint
  first_seen_at     timestamptz
  block_height      int null            -- null tant que non miné
  block_hash        text null
  confirmations     int                 -- recalculé à chaque passage
  notified_at       timestamptz null    -- première notification acceptée (2xx) par le shop

webhook_delivery                       -- file d'envoi : UNE ligne par sortie, seul lien entre scanner et envoi
  id uuid pk, txid, vout (unique ensemble),
  attempts int, next_attempt_at timestamptz,
  last_status_code int null, last_error text null,
  delivered_at null, failed_at null, fail_reason null   -- « rejected » ou « expired »
  created_at                           -- début de la fenêtre de 72 h (remis à zéro par un replay)
  -- en attente = delivered_at et failed_at nuls ; due = next_attempt_at passé

scan_cursor                            -- un seul enregistrement
  last_block_hash null, last_block_height null, lease_owner null, lease_until null
```

**Deux composants, une seule frontière : la table `webhook_delivery`.** Le *scanner* (§6) écrit `received_output` et crée les livraisons ; l'*envoi* (§5) les lit et ne regarde jamais la chaîne. Ils tournent dans le même processus mais ne partagent ni état mémoire ni code, et peuvent être séparés en deux déploiements sans changement.

## 4. API du service (appelée par le shop)

Authentification : en-tête `X-Api-Key: <API_TOKEN>` (secret distinct du secret webhook, 32 caractères minimum). Comparaison en temps constant. Le service n'est joignable que sur le réseau interne.

### 4.1 `POST /v1/invoices`

Demande une adresse et un montant en sats. **Idempotent sur `orderId`** : le même appel rejoue la même réponse (même adresse, même taux), jamais une nouvelle adresse.

```json
// requête
{ "orderId": "uuid", "amountCents": "119000" }
// 201 (création) ou 200 (déjà existante, mêmes valeurs) :
{ "address": "bc1q…", "expectedSats": "1194445", "btcPriceEurCents": "9000000" }
```

- `amountCents` : chaîne d'entiers, > 0. Les sats sont en chaîne également (entiers 64 bits, comme `bigint` côté shop).
- `expectedSats = ceil(amountCents * 1e8 / btcPriceEurCents)` : même formule que `eurCentsToSats` (arrondi au sat supérieur).
- Taux : `/bitcoin-price` (mempool.space, champ `EUR`, en euros entiers) × 100. Si la source est indisponible ou si la donnée a plus de `PRICE_MAX_AGE_SECONDS` (défaut **30 minutes** : mempool.space ne rafraîchit son prix que toutes les ~10 minutes, un seuil de 5 minutes refuserait tout) : `503 price_unavailable`, jamais de taux périmé. Le taux utilisé est figé dans la facture.
- Même `orderId` avec un `amountCents` différent : `409 invoice_conflict`.
- Erreurs : `400 invalid_payload`, `401`, `503 price_unavailable`, `503 wallet_unavailable`.

### 4.2 `GET /v1/fee-estimate`

```json
{ "refundNetworkFeeSats": "2000" }
```

Basé sur `estimatesmartfee` (cible 6 blocs) × taille type d'une transaction P2WPKH 1 entrée 2 sorties (~141 vB), avec **plancher et plafond configurables** (`FEE_MIN_SATS`, `FEE_MAX_SATS`). Mis en cache 60 s. Nœud muet : dernière valeur connue (< 1 h), sinon `503 fee_unavailable`. En regtest le nœud n'a pas de données de frais : la route répond toujours `503` et le shop utilise son repli (`PAYMENT_REFUND_NETWORK_FEE_SATS`, §8).

### 4.3 `GET /v1/invoices/{orderId}`

Lecture seule pour le diagnostic et la réconciliation : adresse, sorties reçues, confirmations, état des notifications. `404 invoice_not_found`.

### 4.4 `POST /v1/invoices/{orderId}/replay`

Remet en file l'envoi de toutes les sorties de la facture qui ont atteint le seuil de confirmations (poussière exclue), y compris déjà livrées ou abandonnées ; la fenêtre de 72 h repart de zéro. Réponse `200 { "queued": 2 }`, `404 invoice_not_found`. Le shop est idempotent, donc sans risque.

### 4.5 `GET /health`

Déjà présent. À enrichir : `200` seulement si le nœud répond (`getblockchaininfo`) et si la base est accessible ; corps `{ "node": "ok", "blockHeight": …, "lagBlocks": … }`.

## 5. Webhook (service → shop)

### 5.1 Requête

`POST {SHOP_URL}/api/internal/payments` : **route existante, inchangée.**

```
Authorization: Bearer <PAYMENT_WEBHOOK_SECRET>
Content-Type: application/json
{ "address": "bc1q…", "txid": "…", "vout": 0, "amountSats": "150000" }
```

Le corps reste exactement celui de `paymentInput` (`strictObject` : **aucun champ supplémentaire**, sinon `400`). Les confirmations ne sont pas transmises : le service n'envoie qu'une fois le seuil atteint.

### 5.2 Réponses du shop et conduite du service

| Réponse | Sens | Service |
|---|---|---|
| `201` | paiement enregistré | marque `notified_at` |
| `200` `{ duplicate: true }` | déjà connu | marque `notified_at` |
| `404 unknown_payment_address` | adresse inconnue du shop (facture non commitée, ou autre environnement) | **réessaie** (cas de course : la facture est créée côté shop après la réponse du service) puis alerte après épuisement |
| `409 payment_conflict` | même `(txid, vout)` avec autre facture ou autre montant | **pas de réessai**, alerte immédiate (anomalie grave) |
| `400`, `401` | contrat ou secret erroné | pas de réessai, alerte immédiate |
| `5xx`, délai dépassé (10 s), erreur réseau | shop indisponible | réessaie |

### 5.3 Seuil de confirmations

**Décision Hugo 2026-11-23 : 3 confirmations pour toutes les factures, quel que soit le montant** (un seul seuil, pas de palier). Paramètre `MIN_CONFIRMATIONS`, défaut 3. En regtest (dev et tests), le seuil reste 3 : les tests minent 3 blocs.

Le délai de réservation d'une facture est de 30 minutes côté shop : un paiement notifié après l'expiration reste accepté s'il reste de la place, sinon il est remboursé (comportement existant, `settleOrder`). Un seuil de 3 confirmations (~30 min en moyenne, davantage si les blocs tardent) suffit donc à déclencher ce cas ; l'annoncer au client à la facture (hors périmètre de ce document).

### 5.4 Réessais

Backoff : 5 s, 15 s, 1 min, 5 min, 15 min, puis toutes les heures, avec ±20 % de gigue, **jusqu'à 72 h** depuis `created_at`. Au-delà : `failed_at` posé, `fail_reason = expired` et alerte `webhook_failed_permanently`. Rejeu manuel par `POST …/replay` (§4.4).

Détails d'implémentation (`src/workers/sender.py`) :
- **Plusieurs instances** : une livraison due est réservée par `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` qui repousse `next_attempt_at` d'une minute (bail) : deux instances n'envoient jamais la même, et une instance qui meurt en plein envoi la laisse reprise une minute plus tard.
- **Statuts** : `200`/`201` livré ; `404`, `408`, `425`, `429`, `5xx`, délai dépassé (10 s, `WEBHOOK_TIMEOUT_SECONDS`) et erreur réseau réessayés ; tout autre `4xx` (400, 401, 409…) refus définitif, `fail_reason = rejected`, alerte `webhook_rejected`. Un `404` alerte en `WARNING`, en `ERROR` au-delà d'une heure.
- **Sortie retombée sous le seuil** depuis la mise en file (réorganisation) : l'envoi la retient (contrôle toutes les minutes, sans compter d'essai) tant que le scanner ne l'a pas reconfirmée.
- `received_output.notified_at` n'est posé qu'à la première livraison acceptée ; un replay ne le réécrit pas.

Ordre : pas de garantie, le shop est insensible à l'ordre.

### 5.5 Réorganisation de chaîne

Si une sortie **déjà notifiée** disparaît (réorg profonde) : le service n'a aucun moyen de l'annuler côté shop. Il journalise `ERROR reorg_after_notification` avec `txid`, `vout`, `orderId`, et alerte. Traitement manuel. Le seuil de confirmations (§5.3) rend le cas très improbable. Une route d'annulation de paiement côté shop est **hors périmètre**, à ouvrir seulement si le cas se présente.

## 6. Dérivation et surveillance

### 6.1 Adresses

- Type : **P2WPKH (`bc1q…`)**, dérivation `…/0/<index>` (branche de réception). `index` vient de la séquence Postgres de `invoice.derivation_index` (démarre à 1, croît à chaque nouvelle facture ; des trous sont possibles après un rollback et sans conséquence). L'unicité est garantie par la base, sans verrou applicatif.
- Réseau : `BITCOIN_NETWORK` ∈ `main | testnet4 | regtest` (dev : `regtest` ; staging : testnet ; production : `main`). Au démarrage, le service **refuse de démarrer** si le préfixe de la xpub ne correspond pas (`xpub`/`zpub` pour main, `tpub`/`vpub` pour testnet4 et regtest) ou si le nœud n'est pas sur le même réseau (`getblockchaininfo.chain` : `main`, `testnet4`, `regtest`). Adresses : `bc1q` (main), `tb1q` (testnet4), `bcrt1q` (regtest).
- **Testnet** : à vérifier sur Bitcoin Core 31.2 quel testnet est pris en charge (testnet3 a été abandonné au profit de testnet4 : `-testnet4`). Le document suppose testnet4 ; si le nœud de staging sait encore faire du testnet3, la valeur de `BITCOIN_NETWORK` s'ajuste, le reste ne change pas.
- Si la xpub fournie est une `zpub`/`vpub` (SLIP-132), la convertir en `xpub`/`tpub` pour le descripteur.

### 6.2 Surveillance : deux options, choix à faire

**Option A, recommandée : portefeuille watch-only sur le nœud.**
Wallet descripteur sans clés privées, `importdescriptors` avec `wpkh(<xpub>/0/*)` et `range` suffisant (`[0, 1000]`, étendu quand `derivation_index` approche de la borne, marge de 200). Le service ne dérive pas lui-même : il appelle `deriveaddresses` avec le descripteur et l'index, puis scanne avec `listsinceblock` (curseur `scan_cursor`) toutes les 15 s. Avantages : rescan et réorg gérés par Bitcoin Core, rien à réimplémenter. Inconvénient : le wallet doit exister sur le nœud et les RPC `listsinceblock` doivent y être autorisés. **Validé par Hugo (Bitcoin Core 31.2, 2026-11-23)** ; les wallets descripteurs et `importdescriptors` y sont disponibles. Un wallet par environnement (nom dans `BITCOIN_RPC_WALLET`), créé avec `createwallet` en mode `disable_private_keys=true, descriptors=true`.

**Un nœud par réseau** : le nœud `192.168.1.201` sert la production (`main`). Le staging a besoin de son propre nœud testnet4 (une instance `bitcoind -testnet4` suffit, avec RPC limité au réseau interne) ; le dev utilise un `bitcoind -regtest` en conteneur (§9).

**Option B : sans wallet.** Le service dérive les adresses (lib BIP32, ex. `bip_utils`) et interroge un indexeur (Electrum / mempool.space esplora). Un indexeur public voit les adresses : vie privée perdue ; un indexeur interne représente une dépendance de plus. Non recommandé.

Suite du document sur l'option A.

### 6.3 Algorithme du scanner

Toutes les 15 s (`SCAN_INTERVAL_SECONDS`) :
0. **Bail** : une requête atomique prend ou renouvelle le bail sur `scan_cursor` (`lease_owner`, `lease_until`, 3 intervalles) ; sans bail, l'instance passe son tour. Un verrou consultatif de session ne convient pas ici : le pool de connexions de Prisma ne garantit pas que le verrou reste sur la même connexion.
1. `listsinceblock(last_block_hash, MIN_CONFIRMATIONS + 1, true, true)` ; traiter `transactions` (et `removed`) de catégorie `receive`. **Cible « seuil + 1 »** : le nœud renvoie un curseur `lastblock` situé `seuil + 1` blocs en arrière, donc chaque sortie est revue à chacune de ses confirmations, dont exactement `seuil`, avant que le curseur ne la dépasse. Avec une cible égale au seuil, une sortie passerait de 2 à 4 confirmations sans jamais être vue à 3.
2. Pour chaque sortie : upsert `received_output` (txid, vout, adresse, montant en sats entier : convertir `amount` BTC en `Decimal`, jamais en `float`), mettre à jour `block_height`/`confirmations`.
3. Sortie dont `confirmations >= seuil`, montant au-dessus de `DUST_SATS` et `notified_at IS NULL` : créer la livraison (`INSERT … ON CONFLICT DO NOTHING` : une seule par sortie). Une sortie **déjà notifiée** dont les confirmations retombent sous le seuil (retirée de la chaîne, repassée en mempool, en conflit) déclenche l'alerte `reorg_after_notification` (§5.5).
4. Sortie conflictuelle ou `abandoned` : ignorer, journaliser.
5. Avancer `scan_cursor` à `lastblock` **seulement après** commit des upserts.

Au démarrage : le wallet est créé s'il n'existe pas et le descripteur importé ; si le descripteur n'y était pas encore, l'import rescanne depuis la plus ancienne facture (moins une heure), ce qui rattrape les paiements reçus pendant l'absence du wallet. Reprise ensuite depuis `scan_cursor` ; un curseur absent déclenche un scan complet (`listsinceblock` sans bloc de départ).

**Constatations sur un nœud réel (Bitcoin Core 32.1, regtest)** :
- Core étend lui-même la plage d'un descripteur de 1000 adresses après chaque usage, et **refuse de la réduire** (`new range must include current range`). Le service relit la plage réelle (`listdescriptors`) et ne demande jamais moins que l'existante.
- Les wallets sont notifiés **de façon asynchrone** : un paiement n'apparaît dans `listsinceblock` qu'une fraction de seconde après `sendtoaddress` ou après un bloc. Sans conséquence pour un polling, mais les tests doivent appeler `syncwithvalidationinterfacequeue`.
- Une sortie vue en mempool est enregistrée avec 0 confirmation mais jamais mise en file avant le seuil.

Ne jamais notifier une adresse que le service n'a pas émise (`invoice.address` inconnue : ignorer).

### 6.4 Sorties minuscules

Une sortie ≤ `DUST_SATS` (défaut 1 000) est enregistrée mais **non notifiée** (poussière, anti-spam d'adresses publiées). À confirmer avec le shop : l'appoint minimum d'une facture partiellement payée ne doit pas tomber sous ce seuil.

### 6.5 Prisma et Postgres HA

- **Client** : le service est en Python ; l'ORM est donc **Prisma Client Python** (`prisma-client-py`, générateur `prisma-client-py` dans `schema.prisma`, `interface = "asyncio"` pour aiohttp). Les migrations sont celles de Prisma (`prisma migrate dev` en développement, `prisma migrate deploy` au démarrage du conteneur, comme l'entrypoint du shop). Le CLI Prisma embarque Node : l'image Docker doit le prévoir.
- **Maintenance** : `prisma-client-py` est un projet communautaire, hors du support officiel de Prisma ; Hugo l'utilise depuis deux ans sans souci (2026-11-23), retenu. Épingler les versions de `prisma-client-py` et du CLI Prisma dans `requirements.txt` et le Dockerfile.
- **Migrations** : une seule instance les exécute (verrou consultatif `pg_advisory_lock`) pour éviter des courses au déploiement de plusieurs réplicas.
- **Instances multiples** : le scanner tourne sur **une seule instance à la fois**, par un bail en base (§6.3, étape 0) renouvelé à chaque passage ; une instance qui le perd (failover du cluster, panne) laisse une autre le reprendre au bout de 3 intervalles. L'envoi n'a pas besoin de bail (`SKIP LOCKED`, §5.4). Les écritures (`received_output`, `webhook_delivery`) sont idempotentes par clés, donc un chevauchement bref reste sans doublon de notification (`notified_at` mis à jour par `UPDATE … WHERE notified_at IS NULL`).
- **Failover** : la connexion peut être coupée sans préavis ; tout accès base est réessayé quelques secondes avec backoff avant de lever `db_unavailable`. Les appels qui renvoient une adresse (`POST /v1/invoices`) répondent `503 db_unavailable` plutôt que de répondre sans avoir persisté : **une adresse n'est jamais renvoyée avant d'être committée**.
- **Sauvegardes** : `invoice` est la seule source de correspondance adresse ↔ `orderId` ↔ index. Elle doit suivre la politique de sauvegarde du cluster ; sa perte ne perd pas les fonds (xpub), mais le rattachement aux factures. La xpub et l'index permettent de reconstituer les adresses.

## 7. Configuration du service

| Variable | Défaut | Rôle |
|---|---|---|
| `SERVER_PORT` | 8086 | existant |
| `BITCOIN_RPC_HOST`, `_PORT`, `_USER`, `_PASSWORD` | | existant ; ajouter `BITCOIN_RPC_WALLET` (nom du wallet watch-only) |
| `BITCOIN_NETWORK` | | `main`, `testnet4` ou `regtest`, **obligatoire** |
| `XPUB` | | xpub de réception, **obligatoire** (secret de confidentialité, pas de clé privée) |
| `API_TOKEN` | | secret de `X-Api-Key` |
| `SHOP_WEBHOOK_URL` | | ex. `http://shop:3000/api/internal/payments` |
| `SHOP_WEBHOOK_SECRET` | | = `PAYMENT_WEBHOOK_SECRET` du shop (32 caractères minimum) |
| `MIN_CONFIRMATIONS` | 3 | §5.3 (seuil unique) |
| `SCAN_INTERVAL_SECONDS` | 15 | §6.3 |
| `DUST_SATS` | 1000 | §6.4 |
| `SENDER_INTERVAL_SECONDS`, `WEBHOOK_TIMEOUT_SECONDS` | 2, 10 | §5.4 |
| `FEE_MIN_SATS`, `FEE_MAX_SATS` | 500, 20 000 | §4.2 |
| `DATABASE_URL` | | Postgres ; secret, `DATABASE_URL_FILE` en Swarm. Staging et production : valeur dans le stack file (le code ne dépend d'aucun nom de base, de rôle ni d'hôte). Dev : conteneur `postgres:16-alpine` du `docker-compose.yaml` |

Les secrets passent par des fichiers (`*_FILE`) comme côté shop (voir `docs/deploy.md`). `.env` n'est jamais versionné.

## 8. Changements côté shop

1. **Nouvelle implémentation** `HttpPaymentService implements PaymentService` dans `src/server/payment-service.ts` :
   - `requestInvoice` → `POST /v1/invoices` ; renvoie `{ address, expectedSats: BigInt(...) }`. Délai 5 s, aucune relance automatique : en cas d'échec, `503` côté API de création de facture, aucune facture créée.
   - `estimateRefundNetworkFeeSats` → `GET /v1/fee-estimate`, avec repli sur `PAYMENT_REFUND_NETWORK_FEE_SATS` si le service est indisponible (ne doit pas bloquer `settleOrder`).
2. **Sélection** par configuration : `PAYMENT_SERVICE_URL` + `PAYMENT_SERVICE_TOKEN` présents → `HttpPaymentService`, sinon `SimulatedPaymentService` (dev, tests, CI). `getPaymentService()` reste le point d'entrée unique.
3. **Création de facture et adresse** : l'appel au service se fait **avant** la transaction qui crée la facture (adresse unique en base, déjà imposé par l'index) ; si la transaction échoue après l'appel, l'adresse est perdue (index consommé), sans conséquence : la rejouer avec le même `orderId` renvoie la même adresse. Utiliser l'`id` de la facture comme `orderId` (le générer avant l'appel).
4. **Route entrante** : aucun changement de contrat. Vérifier que `404 unknown_payment_address` pour une adresse émise mais dont la facture n'est pas encore visible ne peut pas arriver : créer la facture en base **avant** d'exposer l'adresse n'est pas possible (l'adresse vient du service). Le réessai du service (§5.2) couvre la fenêtre de course.
5. **Tests** : service HTTP simulé (`nock`/MSW) pour les cas : réponse nominale, `503 price_unavailable`, délai dépassé, `409 invoice_conflict`. Test de contrat : le corps envoyé par le service passe `paymentInput`.
6. **Doc** : mettre à jour `docs/api.md` (« Paiement : point d'entrée interne »), `docs/deploy.md` (variables) et `docs/roadmap.md` (le service n'est plus simulé en production).

## 9. Tests du service

- **Unitaires** : conversion EUR → sats (arrondi supérieur, mêmes cas que `tests/unit/server/payments.test.ts`) ; conversion BTC → sats par `Decimal` ; dérivation d'adresse (vecteurs de test BIP84) ; backoff.
- **Intégration sur regtest** (`bitcoind -regtest` en conteneur) : facture → envoi de fonds (`sendtoaddress`) → blocs minés (`generatetoaddress`) → webhook reçu une fois, avec le montant exact ; redémarrage du service au milieu (rattrapage sans perte ni doublon) ; shop indisponible puis rétabli (réessais) ; `409 payment_conflict` (pas de réessai) ; deux sorties sur la même adresse (deux notifications distinctes, `vout` différents).
- **Contrat** : un test dans chaque dépôt avec le même fichier d'exemples JSON (requête/réponse de §4 et §5).

## 10. Exploitation et sécurité

- Le service n'est joignable que depuis le shop (réseau Swarm interne) ; le shop n'accepte le webhook que par secret Bearer (déjà le cas).
- Aucune clé privée dans le service ; la xpub est confidentielle (elle révèle toutes les adresses de la boutique et leurs soldes).
- Journaux : jamais d'`Authorization`, de `X-Api-Key`, de xpub ni de mot de passe RPC.
- **Alertes par les logs** (Alertmanager viendra ensuite : le service n'a aucune dépendance à lui). Convention : toute ligne qui doit alerter est au niveau `ERROR` (ou `WARNING` pour les dégradations) avec les champs structurés `alert=true` et `alert_name=<nom>`, plus `order_id`, `txid`, `vout` quand ils existent, **jamais de secret**. Les règles Loki/Promtail ou les métriques se brancheront sur `alert_name`. Noms réservés :

| `alert_name` | Niveau | Condition |
|---|---|---|
| `webhook_failed_permanently` | ERROR | épuisement des 72 h de réessais |
| `webhook_rejected` | ERROR | `400`, `401` ou `409` du shop (pas de réessai) |
| `webhook_unknown_address` | WARNING puis ERROR | `404 unknown_payment_address` : WARNING aux premiers essais, ERROR après 1 h |
| `reorg_after_notification` | ERROR | sortie notifiée disparue (§5.5) |
| `scanner_stalled` | ERROR | curseur sans avancée depuis plus de 10 min |
| `node_unreachable` | ERROR | RPC injoignable plus de 2 min |
| `db_unavailable` | WARNING | base injoignable, journalisée à chaque occurrence ; la durée (plus de 1 min, un failover HA est normal avant) se règle dans la règle Alertmanager (`for: 1m`) |
| `price_unavailable` | WARNING | taux périmé ou source indisponible |
| `node_unreachable` (dérivation, frais) | WARNING | une requête a échoué ; l'alerte ERROR de la ligne précédente (plus de 2 min) se règle dans Alertmanager |
| `reconciliation_mismatch` | ERROR | écart avec la table `Payment` du shop |

  Une alerte est journalisée à chaque occurrence, pas une seule fois : le dédoublonnage est du ressort d'Alertmanager.
- **Réconciliation quotidienne** (tâche planifiée, étape 3 du plan) : comparer `received_output` notifiées avec la table `Payment` du shop ; tout écart est une alerte.

## 11. Plan de réalisation

1. **Assainissement** `bitcoin-service` : fournir `.env.example` (`.env` est déjà ignoré par git), ajouter `api_token` aux `Settings`, brancher `require_auth`, ajouter Prisma (schéma, première migration, entrypoint) et la convention de logs d'alerte (§10).
2. **Factures** : `POST /v1/invoices` (dérivation, taux, idempotence), `GET /v1/invoices/{orderId}`, `GET /v1/fee-estimate`. Tests unitaires.
3. **Scanner et webhook, en deux parties indépendantes** : **3a** scanner (polling `listsinceblock`, seuil de 3 confirmations, mise en file) ; **3b** envoi (réessais, backoff, `replay`). Tests d'intégration regtest (dev et CI). *Fait le 2026-11-23 (`bitcoin-service`, branche `feature/invoices-webhook`).*
4. **Shop** : `HttpPaymentService`, sélection par configuration, tests, docs.
5. **Recette en staging sur testnet4** (xpub de test, nœud testnet4 dédié, wallet watch-only dédié) de bout en bout : facture réelle, paiement partiel, appoint, paiement après expiration.
6. **Bascule en production** sur `main` : vérification du préfixe d'adresse (`bc1q`), du réseau du nœud et de `MIN_CONFIRMATIONS=3` ; premier paiement réel de faible montant.

## 12. Questions ouvertes

Tranchées le 2026-11-23 : seuil de 3 confirmations partout, wallet watch-only sur Bitcoin Core 31.2, regtest en dev et testnet en staging, `prisma-client-py` retenu.

1. Nœud testnet4 de staging : existe-t-il déjà, sinon qui le déploie (étape 5) ? Vérifier sur Core 31.2 le nom du réseau de test pris en charge (§6.1).
