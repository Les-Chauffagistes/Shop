/** Raison « à traiter » en clair (libellé court ; le détail est dans `attention.label` de l'API). */
export const ATTENTION_REASONS: Record<string, string> = {
  admin_decision: "Décision de la boutique",
  user_decision: "Choix de l'utilisateur attendu",
  awaiting_decision: "Paiement complet à traiter",
  overpayment_decision: "Excédent à décider",
  refund_address_missing: "Adresse de remboursement manquante",
  offchain_refund_unsent: "Remboursement à rendre",
};

/** Facture entièrement payée mais pas acceptée (`payment.fullPaymentHold`) : état et conséquence, pour l'admin. */
export const FULL_PAYMENT_HOLDS: Record<string, string> = {
  settling: "Paiement complet reçu, validation automatique en cours : la commande va passer payée, rien à faire.",
  no_room:
    "Paiement complet reçu, mais plus aucune machine disponible : la boutique rembourse tout (frais à sa charge) à la fin de la réservation.",
  batch_closed: "Paiement complet reçu, mais le lot a fermé aux commandes pendant le paiement : à vous de décider (accepter ou rembourser).",
};

/** Qui a annulé la facture (`cancelReason`, posée par la base ; conservée après acceptation ou remboursement). */
export const CANCEL_REASONS: Record<string, string> = {
  user: "Annulée par le client",
  batch_closed: "Annulée par la fermeture du lot",
  admin: "Annulée par la boutique",
};

/** Canal de la facture (`channel`) : il fixe le moyen de paiement (`online` ⇔ Bitcoin, `manual` ⇔ hors chaîne). */
export const CHANNEL_LABELS: Record<string, string> = {
  online: "En ligne · Bitcoin",
  manual: "Vente manuelle · hors chaîne",
};

/** « client n° 42 », ou « client sans compte » (créé par l'admin pour une vente manuelle, `authUserId: null`). */
export function customerName(authUserId: string | null): string {
  return authUserId === null ? "client sans compte" : `client n° ${authUserId}`;
}

/** Même libellé, en début de phrase. */
export function customerTitle(authUserId: string | null): string {
  const name = customerName(authUserId);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
