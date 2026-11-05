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

## Décisions qui en découlent

- **Question 2 de la roadmap (machine à hashboard défectueuse)** : tranchée dans l'autre sens que la recommandation initiale. Pas d'attribution d'une machine `degraded` sans acceptation explicite du client ; sans acceptation, remboursement. Le backend et l'UI du jalon 5 devront porter cette acceptation (à cadrer au moment du jalon, pas avant).
- **Société en création** : pas de précommande payante réelle avant que la société existe et puisse encaisser. Le sondage n'engage personne et peut continuer.
- **Garantie** : en attendant la réponse du business, les textes ne prévoient que les garanties légales (conformité, vices cachés). Pour un bien d'occasion, la durée de la garantie de conformité peut être ramenée à 1 an minimum par contrat ; à décider.
- **Les machines « pour pièces » ne sont jamais vendues** (déjà acquis par la roadmap : machine morte retirée du stock).
- **Frais réseau sur renoncement : acceptés à la charge de la boutique** (Hugo, 2026-11-05). `user_renounce` passe à la boutique dans `refund_cause_fee_payer` (changement de code à planifier). Le but initial de la règle, se protéger des annulations abusives, doit être porté par d'autres mesures (voir « Annulations abusives »).
- **Remboursement : toujours la somme en BTC réellement reçue, jamais le cours** (Hugo, 2026-11-05). Raison : une conversion laisserait un reliquat ou un manque selon le cours. Les CGV doivent le dire clairement (prix en euros, converti en BTC à la facture, remboursement du même montant en BTC) et le client doit l'accepter explicitement avant de payer. Risque résiduel : le client supporte la variation du cours en euros ; à faire relire.

## Annulations abusives

Les frais réseau ne peuvent plus servir de dissuasion pour un particulier. Contrainte de Hugo : une seule personne fait tourner la boutique (commandes, réception, tuning, livraisons), donc aucune mesure ne doit créer de travail manuel. Le coût réel d'une annulation est le temps de l'admin (remboursement à envoyer, client à contacter), pas les frais réseau (environ 2 000 sats).

### Décidé (Hugo, 2026-11-05) : à faire au jalon de code concerné
1. **Adresse de remboursement obligatoire** à la création de la facture (facultative aujourd'hui). Sans adresse, le remboursement passe en « À traiter » et l'admin doit contacter la personne ; obligatoire, la plupart des remboursements n'ont plus besoin d'échange.
2. **Blocage automatique qui expire seul** : les renoncements comptent avec les abandons dans le compteur existant (par exemple 3 sur 30 jours, valeurs dans `ShopSettings`). Le blocage dure quelques jours puis se lève sans l'admin (aujourd'hui : jusqu'à `OrderBlockRelease`, et un renoncement ne compte pas comme un abandon). Un refus de vente temporaire à un client qui abuse est un motif légitime.

### Reporté
3. Remboursements groupés en une transaction par semaine (dans la limite de 14 jours) : seulement si les annulations deviennent fréquentes. On observe d'abord.
4. Après livraison : clause de dépréciation, retour à la charge du client, remboursement après réception ou preuve d'expédition (à écrire dans les CGV).

### À vérifier avec le juriste
La directive européenne 2023/2673 impose, il me semble, une fonction de rétractation en ligne (type bouton « Se rétracter »), applicable depuis juin 2026, utilisable pendant tout le délai de 14 jours après réception. Si c'est transposé en France, la règle actuelle « après la Précommande, seul l'admin » ne tient pas et le libre-service ne peut pas être retiré. Non confirmé.

## Ce qu'il manque

### Pour les mentions légales et les CGV
1. Société : forme, dénomination, capital, siège, SIRET/RCS, numéro de TVA intracommunautaire, e-mail et téléphone de contact, directeur de la publication, hébergeur.
2. Régime de TVA (assujettie, franchise, TVA sur marge pour l'occasion) : détermine l'affichage « TTC » et le contenu des factures.
3. Médiateur de la consommation (adhésion obligatoire à renseigner dans les CGV).
4. Garantie commerciale éventuelle (business) et durée retenue de la garantie de conformité (1 ou 2 ans).

### Pour la livraison
5. Le délai à annoncer doit couvrir toute la chaîne (achat, réception du fournisseur, contrôle, tuning, transport), pas seulement le transporteur. Sans date annoncée, la loi retient 30 jours, que la précommande ne peut pas tenir. Il faut une date estimée par lot, fixée à la publication, et une règle si elle est dépassée (information du client, possibilité d'annuler et d'être remboursé).
6. Frais de livraison : le devis annonce environ 30 € par envoi. Reste à savoir si c'est par colis ou par machine, quoi faire d'une expédition partielle (deuxième envoi : qui paie ?) et si le montant est TTC. Les frais doivent être affichés avant la commande. Aucun frais de port n'apparaît dans le schéma ni dans la roadmap (seule l'adresse de livraison est modélisée). En cas de rétractation, la livraison standard est remboursée.

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
