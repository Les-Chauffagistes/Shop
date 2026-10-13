/** Raison « à traiter » en clair (libellé court ; le détail est dans `attention.label` de l'API). */
export const ATTENTION_REASONS: Record<string, string> = {
  admin_decision: "Décision de la boutique",
  user_decision: "Choix de l'utilisateur attendu",
  awaiting_decision: "Paiement complet à traiter",
  overpayment_decision: "Excédent à décider",
  refund_address_missing: "Adresse de remboursement manquante",
};

/** Qui a annulé la facture (`cancelReason`, posée par la base ; conservée après acceptation ou remboursement). */
export const CANCEL_REASONS: Record<string, string> = {
  user: "Annulée par le client",
  batch_closed: "Annulée par la fermeture du lot",
  admin: "Annulée par la boutique",
};
