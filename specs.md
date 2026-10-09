# Shop chauffagistes
Opérations de grossiste
Chauffagistes achète des mineurs en lot issus de stocks exceptionnels afin de les revendre à l’unité. Après réception et contrôle, les machines sont emballées et envoyées aux particuliers. 
## Financement
Pour la plupart des cas, le financement provient directement des précommandes des utilisateurs. Le montant reçu par Les Chauffagistes est utilisé pour réaliser l’achat du lot. Ainsi, aucune somme n’est avancée.
Le processus de financement peut être court-circuité si une somme d’investissement peut être débloquée pour l’achat du lot. Dans ce cas, le statut de départ est « Commande en cours »
Tous les statuts
Certains statuts ne sont principalement utiles au backoffice. Ils s’enchaînent dans cet ordre.
	⁃	Brouillon : Un lot existant mais non publié et invisible pour les utilisateurs. Première étape obligatoire
	⁃	Sondage : Le lot est visible et les utilisateurs peuvent montrer leur intérêt pour une machine du lot. Cette étape permet de mesurer s’il est pertinent de poursuivre dans le flux ou non
	⁃	Précommande : 
        ⁃	Les utilisateurs qui avaient déjà montré leur intérêt peuvent précommander de façon prioritaire. 
        ⁃	Les nouveaux utilisateurs qui n’ont pas encore manifesté leur intérêt peuvent également précommander si le stock le permet toujours.
        ⁃	La somme est payée préférentiellement en Bitcoin pour éviter que de l’argent ne transite en grande quantité sur un compte bancaire non professionnel tant que l’entité business n’existe pas.
	⁃	Commande en cours : Statut métier simple qui indique que la palette est en cours d’achat. Pendant cette phase, les précommandes sont toujours ouvertes si le stock le permet
	⁃	Attente de réception : Le lot est commandé et en attente d’être reçu. Les précommandes restent possible si le stock théorique le permet.
	⁃	Contrôle : Statut métier pendant lequel les machines sont examinées et modifiées en fonction des variantes (ex. Kit silencieux, offre avec nettoyage) selon le protocole défini. Les précommandes sont toujours possibles
	⁃	Tuning : Les différentes options d’achat nécessitant un montage sont réalisées.
	⁃	Packaging : Les machines ont été vérifiées et sont sur le point d’être expédiées. Le terme précommande est remplacé par le terme commande simple.
	⁃	En transit : Les machines sont remises au transporteur. 
## Use cases : 
### Création d’un modèle de mineur
Avant toute création de lot, un modèle de mineur doit être enregistré. La création d’un modèle demande la saisie de :
	⁃	Nom du modèle : Un nom simple qui permet d’identifier le modèle
	⁃	Hashrate : Le hashrate théorique de l’appareil
	⁃	Quantité de hashboard : Nombre de hashboards présentes sur l’appareil. Utile pour le contrôle logistique
Optionnel :
	⁃	Description : Une courte description du modèle affiché dans la fiche produit pour les utilisateurs.
### Création d’une option d’achat
Certains produits peuvent être commercialisés sous différentes déclinaisons. Par exemple, avec un Kit silencieux. Ces options payantes sont configurées au niveau du modèle de mineur (afin de mieux gérer la compatibilité du matériel). La création d’une option passe par deux étapes : La création du menu et la création des options. Par exemple pour permettre le choix du kit de ventilation d’un mineur, on crée le menu Ventilation, puis on y crée les options disponibles à l’achat avec les différents kits.
	1.	Création du menu :
La création du menu demande la saisie de :
	⁃	Modèle de mineur : Le modèle sur lequel les options d’achat s’appliquent
	⁃	Type : Définit si le menu est une sélection entre plusieurs options, ou un simple Avec/Sans
	⁃	Titre : Le titre principal du menu, très court
Optionnel :
	⁃	Description : Donne plus d’infos sur le menu d’options
	⁃	Position : Permet de gérer l’ordre dans lequel les menus d’options sont présentés s’il y en a plusieurs pour un produit.
	2.	Création des options :
Dans le cas d’un menu de type « Choix entre options », la création d’une nouvelle option demande la saisie de :
	⁃	Label : Nom de l’option affichée dans le menu
	⁃	Par défaut : Définit si cette option est sélectionnée par défaut. Il doit toujours y en avoir une
	⁃	Prix : Le prix de l’option seule. Il s’ajoute au prix de l’article
Optionnel :
	⁃	Position : Placement de l’option dans la liste d’options

Exemple 1 : Option d’achat avec valeur multiple
On veut permettre à un utilisateur de choisir le type de ventilation qu’il veut ajouter à son S19. Prenons ces options :

| Valeur     | Prix |
|------------|------|
| Sans kit   | 0 €  |
| Air flow   | 35 € |
| Silent kit | 75 € |


La première étape est de créer l’option « Kit de ventilation » dans laquelle on ajoutera les valeurs citées dans le tableau. On a alors dans l’étape 1:
	⁃	Modèle de mineur : S19
	⁃	Type : « Choix entre options »
	⁃	Titre : Kit de ventilation
	⁃	Description : Choisissez le type de ventilation de votre nouvel appareil
Et à l’étape 2 :
	⁃	Label : Sans kit
	⁃	Par défaut : Oui
	⁃	Prix : 0€
	⁃	Position : 0 (la première)

Puis :
	⁃	Label : Air Flow
	⁃	Par défaut : Non
	⁃	Prix : 35€
	⁃	Position : 1

Et :
	⁃	Label : Silent kit
	⁃	Par défaut : Non
	⁃	Prix : 75€
	⁃	Position : 2
### Création de lot
Un utilisateur autorisé peut accéder au backoffice pour gérer les lots mis en vente. La création d’une palette demande la saisie de :
	⁃	Modèle de mineur : Sélection depuis les modèles connus ou redirection vers la création d’un modèle
	⁃	Quantité d’appareils : Nombre de machines vendues dans le lot
	⁃	Prix d’achat : Prix du lot pour le nombre de machine renseignées
Puis de façon optionnelle :
	⁃	Prix de revente : Prix de revente à l’unité
	⁃	Nom du lot : Permet d’identifier le lot ensuite. Nom par défaut {qtt} {modèle}
	⁃	Options à retirer : Liste d’options d’achat associées au modèle mis en vente qui ne doivent pas apparaitre pour ce lot spécifique
	⁃	Dérogation de prix d’option : Liste de dérogations de prix de base d’options de vente
	⁃	Quantité maximale de l’option : Définit le nombre maximum de fois que les utilisateurs peuvent acheter une option si des limites de stock s’appliquent
Le statut par défaut est Brouillon
### Publication du lot pour sondage
Un admin peut vouloir vérifier l’intérêt que peut porter la communauté pour un lot en particulier. Après avoir rempli les détails du lot (modèle, quantité, prix d’achat et prix de revente), il peut publier l’annonce afin que de potentiels acheteurs se manifestent. Le statut de la palette passe alors en « Sondage ». Les informations suivantes apparaissent :
	⁃	Modèle
	⁃	Quantité disponible
	⁃	Prix de revente à l’unité
Cette étape peut être ignorée et la phase de précommande peut être lancée juste après la création du lot. Dans ce cas, personne ne sera prioritaire lors des précommandes.
### Manifester son intérêt pour un lot
Lorsqu’un utilisateur voit un sondage en cours pour un lot, il peut montrer son intérêt en se rendant sur la fiche produit et en réalisant une « pré commande » sans avancer d’argent. L’utilisateur prend connaissance du modèle, du prix unitaire, de la quantité d’articles qui serait disponible et des options d’achat. L’utilisateur peut librement naviguer dans les options et les sélectionner au moment de confirmer. Cette étape permet non seulement à l’utilisateur de montrer son intérêt pour un lot, mais aussi pour les éventuelles options d’achat dont le stock est à prévoir.
### Démarrer les précommande d’un lot
Lorsqu’un admin est satisfait du nombre de d’utilisateurs ayant montré leur intérêt pour un lot, il peut décider d’ouvrir les précommandes. Pendant cette phase, les utilisateurs ayant déjà montré leur intérêt peuvent précommander de façon prioritaire, et les nouveaux utilisateurs peuvent précommander si le stock le permet. Pendant cette phase, l’argent recueilli finance l’achat de la palette de des éventuelles options d’achat.
Pendant cette phase, les utilisateurs fournissent leurs informations de facturation et de livraison.
### Confirmer la commande d’un lot
Lorsque les précommandes le permettent, un admin peut passer commande. Les précommandes restent ouvertes tant que le stock le permet. Le statut devient « Commande en cours ». Il informe aussi les utilisateurs de l’avancement de l’opération. 
### Confirmer la commande des options d’achat
S’applique lorsque du matériel supplémentaire lié aux options d’achat doit être commandé. Le flux logistique du matériel supplémentaire se parallélise au flux d’achats du lot principal, mais n’est pas affiché de façon transparente aux utilisateurs.
Pour chaque modèle de matériel, un workflow logistique sera lancé :
	⁃	Commande en cours
	⁃	Attente de livraison
	⁃	Livré
La phase d’assemblage/montage correspond à la phase « Tuning » du flux du lot.
### Confirmer l’attente de réception d’un lot
Dès que le lot est commandé, ce statut logistique informe les utilisateurs et la logistique que le lot est en attente de réception.
### Confirmer la réception d’un lot
Une fois le lot reçu, un technicien va démarrer la phase de contrôle du lot et passer le lot en phase de « Contrôle ». Les commandes restent possibles tant que le stock le permet. Pendant cette phase, le technicien contrôle les appareils selon le protocole qu’il a défini. Dans cette phase, les machines sont attribuées aux utilisateurs et aux options d’achat choisies. 
### Passer en phase de tuning
Cette phase ne s’applique que lorsque des options d’achat ont été commandées, et que le matériel a été reçu. Dans cette phase, les opérations de montage/assemblage sont réalisées.
### Passer en phase de packaging
La phase démarre dès que toutes les machines sont prêtes. Les machines attribuées à des utilisateurs vont être remises au transporteur.
### Remis au transporteur
Les machines sont remises au transporteur. Pendant cette phase, la logistique reste attentive et met à jour le statut de livraison des machines afin d’informer les utilisateurs. Un éventuel lien de suivi peut être fourni si disponible.