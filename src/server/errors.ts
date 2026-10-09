import { z, ZodError } from "zod";
import { isCrossOriginWrite } from "./origin";

// Messages de validation par défaut de Zod en français (« UUID invalide », « objet attendu, tableau
// reçu »). Réglage global du module zod, posé ici car toute route importe ce fichier ; les messages
// propres à un champ (`error: "…"`) l'emportent.
z.config(z.locales.fr());

/**
 * Corps JSON de toute réponse d'erreur des routes :
 * `{ "error": { "code": "out_of_stock", "message": "…" } }` (+ `issues` pour une entrée invalide).
 * `code` est stable (le frontend s'y branche), `message` est en français et affichable.
 * Jamais de stack, de requête SQL, de valeur saisie ni de donnée personnelle.
 */
export type ErrorBody = {
  error: {
    code: string;
    message: string;
    issues?: { path: string; message: string }[];
    blockers?: Blocker[];
    details?: ErrorDetails;
  };
};

/**
 * Données structurées d'une erreur, pour que l'UI les affiche sans analyser le message
 * (ex. `{ "cooldownEndsAt": "2026-10-07T14:35:00.000Z" }`, `{ "machinesLeft": 2 }`).
 */
export type ErrorDetails = Record<string, string | number | boolean | null>;

/**
 * Élément qui empêche une opération (suppression refusée, prix figé…), pour que l'UI le nomme
 * et propose un lien : `kind` = "batch" (lot), "option_value" (valeur d'option), "part_order"
 * (commande de produit d'un lot), "stock_movement" (mouvements du stock d'un produit).
 */
export type Blocker = { kind: "batch" | "option_value" | "part_order" | "stock_movement"; id: string; label: string };

/**
 * Erreur métier typée, levée par le domaine ou les gardes et renvoyée telle quelle au client.
 * `details` : données structurées (dates ISO, nombres) ; `retryAfterSeconds` : en-tête `Retry-After` (429).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly blockers?: Blocker[],
    readonly extra: { details?: ErrorDetails; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Mapped = { status: number; code: string; message: string };

/** Erreur métier de la table des refus nommés (`message` : pour préciser le texte standard). */
export const apiErrorOf = (mapped: Mapped, message: string = mapped.message) => new ApiError(mapped.status, mapped.code, message);

/** Violation qui ne peut venir que d'un bug du serveur (règle d'écriture interne) : 500, journalisée. */
const BUG: Mapped = { status: 500, code: "internal", message: "Erreur interne. Réessayez plus tard." };

const DEFAULT_NOT_FREE: Mapped = {
  status: 422,
  code: "default_value_not_free",
  message: "La valeur par défaut d'un menu est toujours gratuite (0 €), sans dérogation de prix.",
};
const OPTION_NOT_APPLICABLE: Mapped = {
  status: 409,
  code: "option_not_applicable",
  message: "Ce menu ne s'applique pas à ce lot : il a été ajouté au modèle après la publication du lot.",
};
/** Retrait d'une wishlist convertie en commande payée : garde du domaine (wishlists.ts) et contrainte Wishlist_converted. */
export const WISHLIST_CONVERTED_CANCEL: Mapped = {
  status: 409,
  code: "wishlist_converted",
  message:
    "Cette manifestation d'intérêt est devenue une commande payée : elle ne peut plus être retirée. Pour y renoncer, utilisez « Renoncer » sur la commande (tant que le lot est en précommande), sinon contactez-nous.",
};
/** E-mail de contact au mauvais format (profil ou facture : même règle en base). */
const INVALID_CONTACT_EMAIL: Mapped = {
  status: 422,
  code: "invalid_contact_email",
  message: "Adresse e-mail invalide : indiquez une adresse de la forme nom@domaine.fr, sans espace.",
};
/** Facture sans e-mail de contact (ni saisi ni au profil) : garde du domaine (order-rules.ts) et trigger de la base. */
export const CONTACT_EMAIL_REQUIRED: Mapped = {
  status: 422,
  code: "contact_email_required",
  message: "Indiquez une adresse e-mail : l'équipe s'en sert pour vous contacter au sujet de votre commande.",
};
/** Classer sans suite : une seule fois par facture (garde du domaine et index unique). */
export const EXCESS_ALREADY_DISMISSED: Mapped = {
  status: 409,
  code: "excess_already_dismissed",
  message: "Des sats de cette facture ont déjà été classés sans suite (une seule fois par facture) : remboursez ce qui reste.",
};
export const NOTHING_TO_DISMISS: Mapped = {
  status: 409,
  code: "nothing_to_dismiss",
  message: "Rien à classer sans suite sur cette facture (aucune somme reçue non affectée, ou le solde a changé entre-temps : rechargez la page).",
};
const STOCK_MOVEMENT_INVALID: Mapped = {
  status: 422,
  code: "stock_movement_invalid",
  message: "Mouvement de stock incohérent : vérifiez le type, la quantité, le motif et le lot.",
};

/**
 * Contraintes nommées du schéma (index uniques, CHECK, triggers) ayant un sens métier.
 * Les autres violations retombent sur un mapping générique par SQLSTATE.
 */
const CONSTRAINTS: Record<string, Mapped> = {
  Batch_stock: { status: 409, code: "out_of_stock", message: "Le stock du lot est épuisé." },
  BatchOptionValue_max_qty_stock: {
    status: 409,
    code: "option_out_of_stock",
    message: "Cette option n'est plus disponible en quantité suffisante.",
  },
  Order_batch_open: {
    status: 409,
    code: "batch_not_open",
    message: "Ce lot n'accepte pas de commande actuellement.",
  },
  BatchStatusTransition_current: {
    status: 409,
    code: "batch_status_changed",
    message: "Le statut du lot a changé entre-temps. Rechargez la page.",
  },
  OrderLine_frozen: {
    status: 409,
    code: "order_frozen",
    message: "Cette commande ne peut plus être modifiée.",
  },
  Order_payment_address_key: {
    status: 409,
    code: "payment_address_taken",
    message: "Cette adresse de paiement est déjà utilisée.",
  },
  Wishlist_batch_survey: {
    status: 409,
    code: "wishlist_closed",
    message: "Les manifestations d'intérêt ne sont ouvertes que pendant le sondage du lot.",
  },
  Wishlist_configuration_frozen: {
    status: 409,
    code: "wishlist_not_editable",
    message:
      "Les précommandes de ce lot sont ouvertes : la configuration de cette manifestation d'intérêt ne se modifie plus. Vous pouvez encore la retirer.",
  },
  Wishlist_converted: WISHLIST_CONVERTED_CANCEL,
  Order_late_payment_refund: {
    status: 409,
    code: "payment_must_be_accepted",
    message: "Un paiement reçu alors qu'il reste de la place doit être accepté, pas remboursé.",
  },
  Order_expired_early: {
    status: 409,
    code: "order_not_expired",
    message: "Cette facture n'a pas encore expiré.",
  },
  Order_reservation_length: {
    status: 422,
    code: "reservation_too_long",
    message: "Une facture ne réserve le stock que 30 minutes au plus.",
  },
  Order_refunded_in_full: {
    status: 422,
    code: "refund_incomplete",
    message: "Un remboursement intégral doit renvoyer exactement la somme en bitcoin reçue.",
  },
  Order_refunds: {
    status: 422,
    code: "refund_amount_invalid",
    message: "Montant de remboursement incohérent : il dépasse le montant payé ou ne couvre pas les lignes annulées.",
  },
  Configuration_locked: {
    status: 409,
    code: "configuration_locked",
    message: "Cette configuration est liée à une commande : elle ne peut plus être modifiée.",
  },
  ConfigurationItem_value_enabled: {
    status: 409,
    code: "option_value_withdrawn",
    message: "Cette option n'est pas proposée pour ce lot.",
  },
  BatchStatusTransition_allowed_check: {
    status: 409,
    code: "transition_not_allowed",
    message: "Ce changement de statut n'est pas autorisé.",
  },
  BatchStatusTransition_cancel_refunded: {
    status: 409,
    code: "batch_has_paid_orders",
    message: "Le lot a des commandes payées : remboursez-les avant de l'annuler.",
  },
  // Catalogue : noms uniques, sans tenir compte de la casse ni des espaces de bord
  // (index uniques lower(btrim(…)), migration catalog_unique_names ; seule garde, sûre en concurrence)
  Model_name_ci_key: {
    status: 409,
    code: "model_name_taken",
    message: "Un modèle porte déjà ce nom (majuscules et espaces ignorés). Choisissez un autre nom.",
  },
  Option_model_id_title_ci_key: {
    status: 409,
    code: "option_title_taken",
    message: "Ce modèle a déjà un menu d'options de ce titre (majuscules et espaces ignorés). Choisissez un autre titre.",
  },
  OptionValue_option_id_label_ci_key: {
    status: 409,
    code: "option_value_label_taken",
    message: "Ce menu a déjà une valeur de ce libellé (majuscules et espaces ignorés). Choisissez un autre libellé.",
  },
  Part_name_ci_key: {
    status: 409,
    code: "part_name_taken",
    message: "Un produit porte déjà ce nom (majuscules et espaces ignorés). Choisissez un autre nom.",
  },
  // Catalogue et lots (gardes du domaine en amont ; la base reste le dernier rempart)
  OptionValue_default_required: {
    status: 409,
    code: "default_value_required",
    message: "Chaque menu d'options doit avoir une valeur par défaut.",
  },
  OptionValue_one_default_per_option: {
    status: 409,
    code: "default_value_conflict",
    message: "Ce menu d'options a déjà une valeur par défaut.",
  },
  BatchOptionValue_default_enabled: {
    status: 409,
    code: "default_value_withdrawn",
    message: "La valeur par défaut d'un menu ne peut pas être retirée d'un lot.",
  },
  Batch_resale_unit_price_required_check: {
    status: 422,
    code: "resale_price_required",
    message: "Le prix de revente est obligatoire pour publier le lot.",
  },
  // Options (schéma v4) : défaut gratuit, menus Avec/Sans, catalogue figé par la publication
  OptionValue_default_free_check: DEFAULT_NOT_FREE,
  BatchOptionValue_default_free: DEFAULT_NOT_FREE,
  ConfigurationItem_default_free: DEFAULT_NOT_FREE,
  OptionValue_toggle_two_values: {
    status: 409,
    code: "toggle_values_fixed",
    message: "Un menu Avec/Sans a exactement deux valeurs : on ne peut ni en ajouter ni en supprimer.",
  },
  OptionValue_toggle_default_fixed: {
    status: 409,
    code: "toggle_default_fixed",
    message: "Menu Avec/Sans : « Sans » est toujours la valeur par défaut, « Avec » ne peut pas le devenir.",
  },
  Option_kind_fixed: {
    status: 409,
    code: "option_kind_fixed",
    message: "Le type d'un menu qui a des valeurs ne change plus.",
  },
  OptionValue_default_change_locked: {
    status: 409,
    code: "default_change_locked",
    message:
      "Changer la valeur par défaut de ce menu modifierait une manifestation d'intérêt ou une commande existante : ce n'est pas possible.",
  },
  OptionValue_price_frozen: {
    status: 409,
    code: "option_price_frozen",
    message:
      "Le prix catalogue de cette valeur est figé : un lot publié la propose. Pour changer son prix sur un lot, utilisez une dérogation de prix sur ce lot.",
  },
  OptionValue_option_frozen: {
    status: 409,
    code: "option_value_frozen",
    message: "Cette valeur est proposée par un lot publié : elle ne peut pas changer de menu.",
  },
  BatchOption_snapshot: {
    status: 409,
    code: "batch_menus_frozen",
    message: "Les menus d'un lot sont figés à sa publication.",
  },
  BatchOption_hidden_locked: {
    status: 409,
    code: "menu_visibility_locked",
    message: "Un menu ne se masque ou ne s'affiche qu'en brouillon ou pendant le sondage.",
  },
  BatchOption_hidden_chosen: {
    status: 409,
    code: "hidden_menu_has_choices",
    message: "Ce menu est masqué sur le lot alors qu'une configuration y a un choix.",
  },
  BatchOptionValue_snapshot: {
    status: 409,
    code: "batch_option_values_frozen",
    message: "Les réglages d'options d'un lot publié ne sont jamais supprimés : retirez la valeur du lot à la place.",
  },
  BatchOptionValue_option_applicable: OPTION_NOT_APPLICABLE,
  ConfigurationItem_option_applicable: OPTION_NOT_APPLICABLE,
  BatchOptionValue_batch_open: {
    status: 409,
    code: "batch_finished",
    message: "Ce lot est clôturé ou annulé : aucune valeur d'option ne peut plus y être proposée.",
  },
  ConfigurationItem_option_hidden: {
    status: 409,
    code: "option_hidden",
    message: "Ce menu est masqué sur ce lot : sa valeur par défaut s'applique d'office.",
  },
  Configuration_complete: {
    status: 422,
    code: "configuration_incomplete",
    message: "La configuration doit comporter un choix pour chaque menu proposé par le lot.",
  },
  // Stock des produits d'options
  PartStockMovement_kind_check: STOCK_MOVEMENT_INVALID,
  PartStockMovement_created_by_check: STOCK_MOVEMENT_INVALID,
  PartStockMovement_kit_model: {
    status: 422,
    code: "part_not_for_model",
    message: "Ce produit n'équipe aucune option du modèle de ce lot.",
  },
  PartStockMovement_append_only: {
    status: 409,
    code: "stock_movement_immutable",
    message: "Le journal de stock ne se modifie pas : enregistrez une correction à la place.",
  },
  PartStockMovement_batch_part_order_id_part_id_key: {
    status: 409,
    code: "part_order_already_received",
    message: "La réception de cette commande est déjà enregistrée.",
  },
  Part_stock_non_negative: {
    status: 409,
    code: "part_stock_insufficient",
    message: "Stock insuffisant : le stock de ce produit ne peut pas devenir négatif.",
  },
  BatchPartOrder_batch_id_part_id_key: {
    status: 409,
    code: "part_order_exists",
    message: "Ce produit est déjà commandé pour ce lot : modifiez la commande existante.",
  },
  BatchPartOrder_status_transition: {
    status: 409,
    code: "part_order_status_invalid",
    message: "Une commande de produit avance seulement : commandée, puis en attente de livraison, puis livrée.",
  },
  BatchPartOrder_immutable: {
    status: 409,
    code: "part_order_frozen",
    message: "Le lot et le produit d'une commande ne changent pas, ni sa quantité une fois livrée.",
  },
  BatchPartOrder_reception: {
    status: 409,
    code: "part_order_reception_required",
    message: "Une commande est livrée si et seulement si sa réception est enregistrée au stock.",
  },
  // ─── Factures, paiements, remboursements (schéma v5 à v5f) ───
  // Création d'une facture (Order_guard, OrderLine_guard). Le domaine (orders.ts) vérifie les mêmes
  // règles avant d'écrire, avec un message daté ; ces entrées servent si la base refuse quand même.
  Order_priority_window: {
    status: 409,
    code: "order_priority_window",
    message:
      "Les précommandes de ce lot sont encore réservées aux personnes qui avaient manifesté leur intérêt, dans la limite du nombre de machines souhaitées.",
  },
  OrderLine_priority_quota: {
    status: 409,
    code: "order_priority_quota",
    message:
      "Pendant la journée de priorité, vous ne pouvez pas commander plus de machines que vous n'en aviez souhaité sur ce lot.",
  },
  Order_one_live_per_user_batch: {
    status: 409,
    code: "order_already_pending",
    message: "Vous avez déjà une facture en attente de paiement sur ce lot : payez-la ou annulez-la avant d'en créer une autre.",
  },
  Order_abandoned_cooldown: {
    status: 429,
    code: "order_cooldown",
    message: "Vous venez d'abandonner une facture sur ce lot : patientez quelques minutes avant d'en créer une nouvelle.",
  },
  Order_abandoned_limit: {
    status: 409,
    code: "order_creation_blocked",
    message: "Les commandes sont suspendues pour vous sur ce lot après plusieurs factures abandonnées : contactez-nous.",
  },
  Order_max_lines: {
    status: 422,
    code: "order_too_many_lines",
    message: "Cette facture dépasse le nombre maximal de machines par facture.",
  },
  OrderLine_wishlist_live: {
    status: 409,
    code: "wishlist_withdrawn",
    message: "Une des manifestations d'intérêt commandées a été retirée : elle ne peut plus être commandée.",
  },
  OrderLine_order_id_wishlist_id_key: {
    status: 409,
    code: "wishlist_duplicated",
    message: "Une manifestation d'intérêt ne peut figurer qu'une fois dans une facture.",
  },
  OrderLine_wishlist_converted_once: {
    status: 409,
    code: "wishlist_converted",
    message: "Cette manifestation d'intérêt est déjà devenue une commande payée.",
  },
  Wishlist_cap: {
    status: 409,
    code: "wishlist_limit_reached",
    message: "Vous avez atteint le nombre maximal de manifestations d'intérêt sur ce lot.",
  },
  // Statuts et montants d'une facture
  Order_paid_in_full_check: {
    status: 409,
    code: "order_not_paid_in_full",
    message: "La facture n'est pas payée intégralement : elle ne peut pas être acceptée.",
  },
  Order_refunded_payment_check: {
    status: 409,
    code: "order_nothing_received",
    message: "Aucun paiement n'a été reçu sur cette facture : il n'y a rien à rembourser.",
  },
  Order_expected_sats_check: { status: 422, code: "order_amount_invalid", message: "Le montant attendu en bitcoin est invalide." },
  Order_received_sats_check: { status: 422, code: "order_amount_invalid", message: "Le montant reçu en bitcoin est invalide." },
  Order_payment_address_check: { status: 422, code: "order_amount_invalid", message: "L'adresse de paiement est invalide." },
  Order_status_transition: {
    status: 409,
    code: "order_status_invalid",
    message: "Cette facture a changé de statut entre-temps : rechargez la page.",
  },
  Order_status_dates_check: { status: 422, code: "order_status_invalid", message: "Dates de la facture incohérentes avec son statut." },
  Order_cancel_unpaid: {
    status: 409,
    code: "order_cancel_paid",
    message: "Un paiement a été reçu sur cette facture : elle ne peut plus être annulée. Demandez plutôt le remboursement de votre versement.",
  },
  Order_cancel_expired: {
    status: 409,
    code: "order_cancel_expired",
    message: "Cette facture a déjà expiré : la réservation est terminée, il n'y a plus rien à annuler.",
  },
  // Paiements (journal append-only)
  Payment_txid_vout_key: {
    status: 409,
    code: "payment_duplicate",
    message: "Ce paiement (transaction et sortie) est déjà enregistré.",
  },
  Payment_amount_sats_check: { status: 422, code: "payment_invalid", message: "Le montant d'un paiement doit être positif." },
  Payment_txid_check: { status: 422, code: "payment_invalid", message: "La transaction d'un paiement est obligatoire." },
  Payment_vout_check: { status: 422, code: "payment_invalid", message: "La sortie d'un paiement doit être positive ou nulle." },
  // Remboursements
  Refund_kind_check: {
    status: 422,
    code: "refund_invalid",
    message: "Un remboursement d'excédent ne porte sur aucun montant en euros, une annulation ou un rabais toujours.",
  },
  Refund_kind_lines: {
    status: 422,
    code: "refund_invalid",
    message: "Une annulation rembourse au moins une machine ; un rabais ou un excédent n'en rembourse aucune.",
  },
  Refund_prorata: {
    status: 422,
    code: "refund_prorata",
    message: "Le montant en bitcoin remboursé doit être au prorata de ce qui a été payé.",
  },
  Refund_overpayment: {
    status: 422,
    code: "refund_overpayment_exceeded",
    message: "Le remboursement d'excédent dépasse ce qui a été reçu en trop.",
  },
  Refund_network_fee_sats_check: { status: 422, code: "refund_invalid", message: "Les frais réseau ne peuvent pas être négatifs." },
  Refund_partial_payment_allowed: {
    status: 409,
    code: "refund_not_allowed",
    message:
      "Le remboursement de votre versement n'est possible que pour une facture partiellement payée, non acceptée, d'un lot qui accepte encore les commandes.",
  },
  Refund_user_net_positive: {
    status: 409,
    code: "refund_below_network_fee",
    message: "Le montant à rembourser ne couvre pas les frais réseau, à la charge de l'utilisateur pour ce motif.",
  },
  Refund_partial_payment_after_expiry: {
    status: 409,
    code: "order_reservation_running",
    message: "La réservation de cette facture court encore : d'ici là, seul l'utilisateur choisit entre l'appoint et le remboursement.",
  },
  Refund_amount_sats_check: { status: 422, code: "refund_invalid", message: "Le montant en bitcoin d'un remboursement doit être positif." },
  Refund_reason_check: { status: 422, code: "invalid_input", message: "Le motif du remboursement est obligatoire." },
  // Renoncement de l'utilisateur à une commande payée (v5e, v5f)
  Refund_user_renounce_paid: {
    status: 409,
    code: "order_not_paid",
    message: "Seule une commande payée peut faire l'objet d'un renoncement.",
  },
  Refund_user_renounce_window: {
    status: 409,
    code: "order_renounce_closed",
    message: "Le lot a dépassé la phase de Précommande : vous ne pouvez plus renoncer vous-même à cette commande. Contactez-nous.",
  },
  // Adresse de remboursement de la facture et envoi (v5e)
  Order_refund_address_check: {
    status: 422,
    code: "invalid_refund_address",
    message: "Adresse de remboursement invalide (adresse Bitcoin attendue, différente de l'adresse de paiement).",
  },
  Refund_destination_address_check: { status: 422, code: "invalid_refund_address", message: "Adresse Bitcoin de remboursement invalide." },
  Order_refund_address_ours: {
    status: 422,
    code: "refund_address_ours",
    message: "Cette adresse est une adresse de paiement de la boutique : indiquez une adresse de votre portefeuille.",
  },
  Refund_destination_ours: {
    status: 422,
    code: "refund_address_ours",
    message: "Cette adresse est une adresse de paiement de la boutique : un remboursement ne peut pas y être envoyé.",
  },
  Order_refund_address_frozen: {
    status: 409,
    code: "refund_address_frozen",
    message: "Un remboursement de cette facture a déjà été envoyé : l'adresse de remboursement ne se modifie plus. Contactez-nous.",
  },
  Refund_sent_destination: {
    status: 409,
    code: "refund_destination_changed",
    message: "Cette adresse n'est pas (ou plus) l'adresse de destination du remboursement : elle a pu changer entre-temps. Relisez-la, puis confirmez l'envoi.",
  },
  Refund_sent_frozen: {
    status: 409,
    code: "refund_already_sent",
    message: "Ce remboursement est déjà envoyé : il ne se modifie plus.",
  },
  Refund_sent_check: {
    status: 422,
    code: "refund_address_missing",
    message: "Un envoi exige une adresse de destination et la référence de la transaction.",
  },
  Refund_reference_check: { status: 422, code: "invalid_refund_reference", message: "La référence de l'envoi ne peut pas être vide." },
  // E-mail de contact : profil (v5j) et instantané de la facture (v5i, obligatoire depuis v5k)
  User_email_check: INVALID_CONTACT_EMAIL,
  Order_contact_email_check: INVALID_CONTACT_EMAIL,
  Order_contact_email_required: CONTACT_EMAIL_REQUIRED,
  // Classer sans suite (v5i)
  OrderExcessDismissal_within_fee_check: {
    status: 409,
    code: "excess_above_network_fee",
    message: "Cette somme dépasse les frais réseau d'un remboursement : elle ne peut pas être classée sans suite, remboursez-la.",
  },
  OrderExcessDismissal_order_id_key: EXCESS_ALREADY_DISMISSED,
  OrderExcessDismissal_status: NOTHING_TO_DISMISS,
  OrderExcessDismissal_amount: NOTHING_TO_DISMISS,
  OrderExcessDismissal_reason_check: { status: 422, code: "invalid_input", message: "Le motif du classement ne peut pas être vide." },
  Order_dismissed_final: {
    status: 409,
    code: "order_not_acceptable",
    message: "Des sats reçus sur cette facture ont été classés sans suite : elle ne peut plus être acceptée. Remboursez-la.",
  },
  // Levée de blocage, réglages, adresses
  OrderBlockRelease_released_by_check: { status: 422, code: "block_release_invalid", message: "Administrateur de la levée invalide." },
  OrderBlockRelease_reason_check: { status: 422, code: "block_release_invalid", message: "Le motif de la levée ne peut pas être vide." },
  ShopSettings_single_row_check: { status: 422, code: "shop_settings_invalid", message: "Les réglages de la boutique tiennent en une seule ligne." },
  ShopSettings_wishlist_max_check: { status: 422, code: "shop_settings_invalid", message: "Plafond de manifestations d'intérêt : 1 à 1000." },
  ShopSettings_order_max_lines_check: { status: 422, code: "shop_settings_invalid", message: "Machines par facture : 1 à 1000." },
  ShopSettings_cooldown_check: { status: 422, code: "shop_settings_invalid", message: "Délai après abandon : 0 à 1440 minutes." },
  ShopSettings_abandoned_limit_check: { status: 422, code: "shop_settings_invalid", message: "Plafond d'abandons : 1 à 100." },
  ShopSettings_abandoned_window_check: { status: 422, code: "shop_settings_invalid", message: "Fenêtre des abandons : 1 à 720 heures." },
  Address_country_check: { status: 422, code: "invalid_input", message: "Code pays à deux lettres majuscules attendu (ex. FR)." },
  Address_frozen: {
    status: 409,
    code: "address_frozen",
    message: "Cette adresse est utilisée par une commande : elle ne se modifie plus.",
  },
  // Règles d'écriture internes : leur violation est un bug du serveur, jamais une faute de l'utilisateur
  // (v5d : position posée par la base ; v5e/v5f : motif, payeur des frais, initiateur, acteur déclaré)
  OrderLine_order_id_position_key: BUG,
  OrderLine_position_check: BUG,
  Refund_cause_fee_payer: BUG,
  Refund_system_above_fee: BUG,
  Refund_late_payment_full: BUG,
  Refund_cause_check: BUG,
  Refund_fee_payer_check: BUG,
  Refund_fee_single_line_check: BUG,
  Refund_cause_remainder: BUG,
  Refund_admin_traced_check: BUG,
  Refund_sent_by_check: BUG,
  OrderRefundAddressChange_actor: BUG,
  OrderRefundAddressChange_actor_user: BUG,
  OrderRefundAddressChange_append_only: BUG,
  OrderRefundAddressChange_changed_check: BUG,
  OrderRefundAddressChange_actor_auth_user_id_check: BUG,
  Order_created_pending: BUG,
  Order_immutable: BUG,
  Order_received_via_payment: BUG,
  Order_status_lines: BUG,
  Order_lines: BUG,
  Order_total: BUG,
  Order_no_delete: BUG,
  OrderLine_no_delete: BUG,
  OrderLine_new: BUG,
  OrderLine_amount: BUG,
  OrderLine_configuration_own: BUG,
  OrderLine_refunded_once: BUG,
  OrderLine_machine_via_assignment: BUG,
  Payment_append_only: BUG,
  Refund_append_only: BUG,
  Refund_immutable: BUG,
  OrderBlockRelease_append_only: BUG,
  ShopSettings_no_delete: BUG,
  ShopSettings_required: BUG,
  // v5i : instantané d'e-mail jamais réécrit, journaux append-only, valeurs posées par le serveur
  Order_contact_email_frozen: BUG,
  OrderExcessDismissal_append_only: BUG,
  OrderExcessDismissal_dismissed_by_check: BUG,
  OrderExcessDismissal_sats_check: BUG,
  OrderExcessDismissal_network_fee_sats_check: BUG,
  WishlistOptionWithdrawal_append_only: BUG,
};

const BY_SQLSTATE: Record<string, Mapped> = {
  "23505": { status: 409, code: "conflict", message: "Cet élément existe déjà." },
  "23503": { status: 409, code: "reference_conflict", message: "Un élément lié est introuvable ou encore utilisé." },
  "23514": { status: 422, code: "constraint_violation", message: "L'opération enfreint une règle métier." },
  "23001": { status: 409, code: "reference_conflict", message: "Un élément lié est introuvable ou encore utilisé." },
  "22P02": { status: 400, code: "invalid_input", message: "Une valeur fournie est invalide." },
  // Conflit de sérialisation ou interblocage : le client peut réessayer.
  "40001": { status: 409, code: "retry", message: "Opération concurrente, veuillez réessayer." },
  "40P01": { status: 409, code: "retry", message: "Opération concurrente, veuillez réessayer." },
};

const INTERNAL: Mapped = BUG;

/** Erreur Postgres telle que remontée par Prisma + PrismaPg. */
type PgFailure = { sqlstate: string; constraint?: string };

/**
 * Extrait SQLSTATE et nom de contrainte. Deux formes possibles :
 * - PrismaClientKnownRequestError : `meta.driverAdapterError.cause` ;
 * - DriverAdapterError brute (erreur d'un trigger différé, levée au COMMIT) : `cause`.
 * PrismaPg ne conserve `constraint` que pour unique / clé étrangère ; pour les autres
 * (CHECK, triggers) le nom n'est lisible que dans le message (`… constraint "Nom" …`).
 */
export function pgFailureOf(error: unknown): PgFailure | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { meta?: { driverAdapterError?: { cause?: unknown } }; cause?: unknown; name?: unknown };
  const cause = e.meta?.driverAdapterError?.cause ?? (e.name === "DriverAdapterError" ? e.cause : undefined);
  if (typeof cause !== "object" || cause === null) return null;
  const c = cause as {
    originalCode?: unknown;
    originalMessage?: unknown;
    hint?: unknown;
    constraint?: { index?: unknown };
  };
  if (typeof c.originalCode !== "string") return null;
  const fromIndex = typeof c.constraint?.index === "string" ? c.constraint.index : undefined;
  const text = [c.originalMessage, c.hint].filter((t) => typeof t === "string").join("\n");
  const fromText = /constraint "([^"]+)"/.exec(text)?.[1];
  return { sqlstate: c.originalCode, constraint: fromIndex ?? fromText };
}

type Described = Mapped & Pick<ErrorBody["error"], "issues" | "blockers" | "details"> & { retryAfterSeconds?: number };

/** Réponse décrite par une contrainte de la base (`null` si l'erreur ne vient pas de Postgres). */
export function describeConstraint(error: unknown): Mapped | null {
  const pg = pgFailureOf(error);
  if (!pg) return null;
  return (pg.constraint && CONSTRAINTS[pg.constraint]) || BY_SQLSTATE[pg.sqlstate] || INTERNAL;
}

function describe(error: unknown): Described {
  if (error instanceof ApiError) {
    const { status, code, message, blockers, extra } = error;
    return {
      status,
      code,
      message,
      ...(blockers ? { blockers } : {}),
      ...(extra.details ? { details: extra.details } : {}),
      ...(extra.retryAfterSeconds !== undefined ? { retryAfterSeconds: extra.retryAfterSeconds } : {}),
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: "invalid_input",
      message: "Certaines données envoyées sont invalides.",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }
  return describeConstraint(error) ?? INTERNAL;
}

/** Convertit n'importe quelle erreur en réponse JSON uniforme. */
export function toErrorResponse(error: unknown): Response {
  const { status, code, message, issues, blockers, details, retryAfterSeconds } = describe(error);
  if (status >= 500) logUnexpected(error);
  const body: ErrorBody = {
    error: { code, message, ...(issues ? { issues } : {}), ...(blockers ? { blockers } : {}), ...(details ? { details } : {}) },
  };
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfterSeconds !== undefined) headers["Retry-After"] = String(Math.max(1, Math.ceil(retryAfterSeconds)));
  return Response.json(body, { status, headers });
}

/** 403 `cross_origin` : écriture venue d'un autre site (CSRF), voir `./origin.ts`. */
export const crossOriginError = () =>
  new ApiError(403, "cross_origin", "Requête refusée : elle ne provient pas de la boutique. Rechargez la page et réessayez.");

/**
 * Enveloppe un handler de route : refuse d'abord une écriture cross-origin (403 `cross_origin`),
 * puis convertit toute erreur levée en réponse JSON uniforme.
 */
export function withErrorHandling<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      const request = args[0];
      if (request instanceof Request && isCrossOriginWrite(request)) throw crossOriginError();
      return await handler(...args);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

// Journal minimal : les messages d'erreur (Prisma, Postgres) peuvent contenir des valeurs
// de lignes, donc des données personnelles. On ne trace que le type, le code et la contrainte.
function logUnexpected(error: unknown) {
  const pg = pgFailureOf(error);
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  console.error(
    JSON.stringify({
      level: "error",
      msg: "unhandled route error",
      name,
      code: typeof code === "string" ? code : undefined,
      sqlstate: pg?.sqlstate,
      constraint: pg?.constraint,
    }),
  );
}
