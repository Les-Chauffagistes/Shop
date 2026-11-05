# Cadre légal : réponses, décisions et points ouverts

Document de travail (2026-11-05). Aucun texte juridique n'est encore rédigé : on fige d'abord les faits et les décisions pour ne pas réécrire. Les points de droit sont un cadrage (droit français de la consommation), à faire relire par un juriste avant la mise en production avec de l'argent réel.

## Faits donnés par Hugo

| Sujet | Réponse |
|---|---|
| Clientèle | Particuliers uniquement (B2C) : droit de rétractation de 14 jours applicable |
| Vendeur | Une société, en cours de création. Forme, dénomination, SIRET : pas encore connus |
| État des machines | Toujours d'occasion. Parfois reconditionnées par nous (changement de hashboard ou d'alimentation). Ce qui ne fonctionne pas est gardé pour pièces |
| Non-conformité | On ne vend jamais une machine non conforme, sauf acceptation explicite de l'utilisateur. Par défaut, la commande est remboursée |
| Origine | UE ; certaines machines peuvent venir des USA |
| Zone de livraison | France uniquement |
| Délai de livraison | Inconnu : dépend du transporteur, information non disponible |
| Garantie commerciale | Question transmise à la partie business, sans réponse |
| Livraison | Devis du transporteur : environ 30 € par envoi, à la charge du client. Aucune autre info (par machine, par colis, plusieurs machines dans un envoi ?) |
| Retour | Frais de retour à la charge du client. Montant et procédure inconnus |

### Réponses du 2026-11-05 (suite)

- **Compte et portefeuille BTC** : au nom de la société. Comptabilité tenue en BTC et en euros.
- **Expédition** : une commande est toujours expédiée complète. Si un même utilisateur passe deux commandes et que la seconde part séparément, il paie de nouveau la livraison. Les frais de livraison sont donc par commande (une facture = un envoi). La décision de la roadmap « expédition partielle possible » doit se lire par commande, pas à l'intérieur d'une commande.
- **Rétractation en ligne** : Hugo pense que la boutique permet déjà tout. Vérification demandée (sous-agent en lecture seule), résultat à consigner ci-dessous.

## Décisions qui en découlent

- **Question 2 de la roadmap (machine à hashboard défectueuse)** : tranchée dans l'autre sens que la recommandation initiale. Pas d'attribution d'une machine `degraded` sans acceptation explicite du client ; sans acceptation, remboursement. Le backend et l'UI du jalon 5 devront porter cette acceptation (à cadrer au moment du jalon, pas avant).
- **Société en création** : pas de précommande payante réelle avant que la société existe et puisse encaisser. Le sondage n'engage personne et peut continuer.
- **Garantie** : en attendant la réponse du business, les textes ne prévoient que les garanties légales (conformité, vices cachés). Pour un bien d'occasion, la durée de la garantie de conformité peut être ramenée à 1 an minimum par contrat ; à décider.
- **Les machines « pour pièces » ne sont jamais vendues** (déjà acquis par la roadmap : machine morte retirée du stock).
- **Frais réseau sur renoncement : acceptés à la charge de la boutique** (Hugo, 2026-11-05). `user_renounce` passe à la boutique dans `refund_cause_fee_payer` (fait au jalon L1, 2026-11-05). Le but initial de la règle, se protéger des annulations abusives, doit être porté par d'autres mesures (voir « Annulations abusives »).
- **Remboursement : toujours la somme en BTC réellement reçue, jamais le cours** (Hugo, 2026-11-05). Raison : une conversion laisserait un reliquat ou un manque selon le cours. Les CGV doivent le dire clairement (prix en euros, converti en BTC à la facture, remboursement du même montant en BTC) et le client doit l'accepter explicitement avant de payer. Risque résiduel : le client supporte la variation du cours en euros ; à faire relire.

## Annulations abusives

Les frais réseau ne peuvent plus servir de dissuasion pour un particulier. Contrainte de Hugo : une seule personne fait tourner la boutique (commandes, réception, tuning, livraisons), donc aucune mesure ne doit créer de travail manuel. Le coût réel d'une annulation est le temps de l'admin (remboursement à envoyer, client à contacter), pas les frais réseau (environ 2 000 sats).

### Décidé (Hugo, 2026-11-05) : fait au jalon L1 (2026-11-05)
1. **Adresse de remboursement obligatoire** à la création de la facture (facultative aujourd'hui). Sans adresse, le remboursement passe en « À traiter » et l'admin doit contacter la personne ; obligatoire, la plupart des remboursements n'ont plus besoin d'échange.
2. **Blocage automatique qui expire seul** : les renoncements comptent avec les abandons dans le compteur existant (par exemple 3 sur 30 jours, valeurs dans `ShopSettings`). Le blocage dure quelques jours puis se lève sans l'admin (aujourd'hui : jusqu'à `OrderBlockRelease`, et un renoncement ne compte pas comme un abandon). Un refus de vente temporaire à un client qui abuse est un motif légitime.

### Reporté
3. Remboursements groupés en une transaction par semaine (dans la limite de 14 jours) : seulement si les annulations deviennent fréquentes. On observe d'abord.
4. Après livraison : clause de dépréciation, retour à la charge du client, remboursement après réception ou preuve d'expédition (à écrire dans les CGV).

### Fonction de rétractation en ligne : état du droit et du code (vérification du 2026-11-05)

**Droit (lu par un sous-agent sur le web, partiellement vérifié)**
- Transposition française : ordonnance n° 2026-2 et décret n° 2026-3 du 5 janvier 2026, en vigueur le 19 juin 2026 (Légifrance). Piège : l'ordonnance est titrée « commercialisation à distance de services financiers » mais transpose aussi la directive 2023/2673 pour le code de la consommation (L. 221-18). Les contrats en cours au 19 juin 2026 restent sous l'ancien régime.
- Intitulé : « renoncer au contrat ici » ou formule analogue sans ambiguïté (et non « Se rétracter »).
- Accessible, visible, gratuite, pendant tout le délai de rétractation. Deux étapes : déclaration (nom, prénom, identification du contrat, moyen électronique pour l'accusé), puis bouton « confirmer la rétractation » ou analogue. Accusé de réception sur support durable (e-mail) avec contenu, date et heure, « dans un délai raisonnable ».
- **Non vérifié** : texte de la directive (EUR-Lex illisible), texte exact de L. 221-18-1 et D. 221-5 (la formulation de l'accusé vient d'un article voisin du même décret), applicabilité à des machines configurées par options. À faire confirmer par le juriste.

**Code (lu dans le checkout principal avec les modifications non commitées)**
- Existe : annulation d'une facture en attente (`OrderActions.tsx:43`), remboursement d'un versement partiel (`:98`), « Renoncer » sur une commande payée jusqu'à la Précommande incluse (`OrderActions.tsx:182`, `orders.ts:862`, règle en base `user_renounce_allowed`).
- Après la Précommande : plus de bouton, la page affiche « Contactez-nous » (`mes-commandes/[orderId]/page.tsx:343-347`) ; seul l'admin peut annuler (`cancel-lines`).
- Absent : accès pendant tout le délai de 14 jours ; calcul du délai (pas de date de livraison par commande, `delivered_at` n'existe que sur la machine) ; accusé de réception (aucun envoi d'e-mail dans le code ; `contactEmail` est stocké mais jamais utilisé) ; CGV et page de rétractation.
- Partiel : confirmation en une étape (`ConfirmDialog`) mais sans identification du contrat ni moyen de contact ; bouton « Renoncer à ma commande » sans le libellé réglementaire.
- Frais réseau à la charge du client dans le code (`user_renounce`) : inversé au jalon L1 (2026-11-05), à la charge de la boutique.

**Conclusion** : la rétractation en ligne n'est pas complète. Le travail à planifier : fonction de rétractation disponible jusqu'à 14 jours après réception (donc date de livraison par commande), déclaration en deux étapes, accusé par e-mail (donc un envoi d'e-mails, qui n'existe pas), libellé conforme, frais réseau à la boutique. Aucun code écrit à ce stade.

## Ce qu'il manque

### Pour les mentions légales et les CGV
1. Société : forme, dénomination, capital, siège, SIRET/RCS, numéro de TVA intracommunautaire, e-mail et téléphone de contact, directeur de la publication, hébergeur.
2. Régime de TVA (assujettie, franchise, TVA sur marge pour l'occasion) : détermine l'affichage « TTC » et le contenu des factures.
3. Médiateur de la consommation (adhésion obligatoire à renseigner dans les CGV).
4. Garantie commerciale éventuelle (business) et durée retenue de la garantie de conformité (1 ou 2 ans).

### Pour la livraison
5. Le délai à annoncer doit couvrir toute la chaîne (achat, réception du fournisseur, contrôle, tuning, transport), pas seulement le transporteur. Sans date annoncée, la loi retient 30 jours, que la précommande ne peut pas tenir. Il faut une date estimée par lot, fixée à la publication, et une règle si elle est dépassée (information du client, possibilité d'annuler et d'être remboursé).
6. Frais de livraison : environ 30 € par envoi, donc par commande (une commande part toujours complète ; une seconde commande expédiée séparément repaie la livraison). Reste à savoir si le montant couvre une commande de plusieurs machines (jusqu'à 10) ou varie avec le nombre de machines, et s'il est TTC. Les frais doivent être affichés avant la commande. Aucun frais de port n'apparaît dans le schéma ni dans la roadmap (seule l'adresse de livraison est modélisée). En cas de rétractation, la livraison standard est remboursée.

### Pour les retours et remboursements
7. Procédure de retour : adresse, qui réceptionne, contrôle à réception, mode d'envoi conseillé.
8. Le client doit être informé avant achat du coût de retour : une estimation suffit.
9. Risque propre aux mineurs : un client peut faire tourner la machine puis la rendre. À traiter par une clause de dépréciation et un contrôle au retour.

### Pour les importations (USA)
10. Qui est importateur : droits de douane, TVA à l'import, marquage CE, DEEE et éco-organisme. Question pour la partie business et le comptable.
11. Faut-il afficher l'origine de chaque lot sur la fiche (UE ou hors UE) ?

## Décisions déjà posées qui restent à trancher (discutées, sans réponse)

- **Délai de remboursement** : 14 jours maximum en cas de rétractation. « À traiter » n'affiche aucune échéance.
- **Excédent classé sans suite** : garder un petit excédent suppose une clause qui l'annonce.

## Livrables envisagés (non commencés)

Mentions légales, CGV (précommande et commande), politique de retours et remboursements, formulaire type de rétractation, politique de confidentialité RGPD, texte du sondage. Ensuite dans l'app : liens du pied de page, case d'acceptation des CGV avec version et horodatage stockés sur la commande, bouton « Commander avec obligation de paiement », récapitulatif précontractuel.
