import { describe, expect, it } from "vitest";
import { ApiError } from "@/server/errors";
import {
  attentionOf,
  checkOrderCreation,
  checkRefundCause,
  checkUserRenounce,
  displayStatus,
  formatDayTime,
  formatTime,
  type OrderingContext,
  orderKind,
  type PaymentBalance,
  planAdminRefund,
  planDismissal,
  planLineCancellation,
  planUserRefund,
  resolveContactEmail,
  settlementStep,
} from "@/server/order-rules";

const NOW = new Date("2026-10-07T12:00:00.000Z");

const open: OrderingContext = {
  batchStatus: "preorder",
  acceptsOrders: true,
  priorityEndsAt: null,
  machinesLeft: null,
  liveOrderId: null,
  blockedAt: null,
  cooldownEndsAt: null,
  available: 10,
  maxLines: 10,
  now: NOW,
};

const balance: PaymentBalance = {
  status: "pending_payment",
  expiresAt: new Date(NOW.getTime() + 10 * 60_000),
  totalAmount: 50_000n,
  expectedSats: 100_000n,
  receivedSats: 0n,
  refundedSats: 0n,
  refundDueSats: 0n,
  unsettledSats: 0n,
  dismissedSats: 0n,
  batchOpen: true,
  awaitingDecision: false,
  awaitingUserDecision: false,
  needsAdminDecision: false,
  userRefundAllowed: false,
  refundAddressMissing: false,
  overpaymentUnrefunded: false,
  fitsStock: null,
  userRenounceAllowed: false,
  now: NOW,
};

describe("displayStatus", () => {
  it("une facture en attente dont la réservation est passée s'affiche expirée", () => {
    expect(displayStatus("pending_payment", new Date(NOW.getTime() - 1), NOW)).toBe("expired");
    expect(displayStatus("pending_payment", new Date(NOW.getTime() + 1), NOW)).toBe("pending_payment");
    expect(displayStatus("cancelled", new Date(NOW.getTime() - 1), NOW)).toBe("cancelled");
  });
});

describe("orderKind", () => {
  it("commande simple une fois les machines triées (Tuning, Packaging), précommande sinon", () => {
    expect(orderKind("tuning")).toBe("order");
    expect(orderKind("packaging")).toBe("order");
    for (const s of ["preorder", "ordering", "awaiting_reception", "inspection"] as const) expect(orderKind(s)).toBe("preorder");
    expect(orderKind(null)).toBe("preorder");
  });
});

describe("formatage des dates (heure de Paris)", () => {
  it("« 7 octobre à 14:00 » et « 14:00 »", () => {
    expect(formatDayTime(NOW)).toBe("7 octobre à 14:00");
    expect(formatTime(NOW)).toBe("14:00");
  });
});

describe("checkOrderCreation", () => {
  it("accepte une facture qui tient dans les règles", () => {
    expect(checkOrderCreation(open, 3)).toBeNull();
    expect(checkOrderCreation({ ...open, machinesLeft: 3 }, 3)).toBeNull();
  });

  it("lot fermé aux commandes : message selon le statut", () => {
    expect(checkOrderCreation({ ...open, batchStatus: "survey", acceptsOrders: false }, 1)?.message).toContain(
      "pas encore ouvertes",
    );
    const closed = checkOrderCreation({ ...open, batchStatus: "in_transit", acceptsOrders: false }, 1);
    expect(closed).toMatchObject({ status: 409, code: "batch_not_open" });
    expect(closed?.message).toContain("« En transit »");
  });

  it("journée de priorité sans quota : 409 daté", () => {
    const ends = new Date("2026-10-08T08:30:00.000Z");
    const refused = checkOrderCreation({ ...open, priorityEndsAt: ends, machinesLeft: 0 }, 1)!;
    expect(refused).toMatchObject({ status: 409, code: "order_priority_window" });
    expect(refused.message).toContain("jusqu'au 8 octobre à 10:30");
    expect(refused.extra.details).toEqual({ priorityEndsAt: ends.toISOString(), machinesLeft: 0 });
  });

  it("quota de priorité dépassé : dit combien de machines restent", () => {
    const refused = checkOrderCreation({ ...open, priorityEndsAt: NOW, machinesLeft: 2 }, 3)!;
    expect(refused).toMatchObject({ status: 409, code: "order_priority_quota" });
    expect(refused.message).toContain("encore prendre 2 machines en priorité");
    expect(refused.extra.details?.machinesLeft).toBe(2);
  });

  it("facture vivante, blocage, délai (429 + Retry-After), dans l'ordre de la base", () => {
    const cooldownEndsAt = new Date(NOW.getTime() + 90_000);
    const all = { ...open, liveOrderId: "o1", blockedAt: NOW, cooldownEndsAt };
    expect(checkOrderCreation(all, 1)).toMatchObject({ code: "order_already_pending", extra: { details: { orderId: "o1" } } });
    expect(checkOrderCreation({ ...all, liveOrderId: null }, 1)).toMatchObject({ status: 409, code: "order_creation_blocked" });
    const cooldown = checkOrderCreation({ ...all, liveOrderId: null, blockedAt: null }, 1)!;
    expect(cooldown).toMatchObject({ status: 429, code: "order_cooldown" });
    expect(cooldown.message).toContain("à 14:01");
    expect(cooldown.extra).toEqual({ details: { cooldownEndsAt: cooldownEndsAt.toISOString() }, retryAfterSeconds: 90 });
  });

  it("plafond de machines par facture : cite le vrai plafond", () => {
    const refused = checkOrderCreation({ ...open, maxLines: 4 }, 101)!;
    expect(refused).toMatchObject({ status: 422, code: "order_too_many_lines" });
    expect(refused.message).toBe("Une facture compte au plus 4 machines : vous en demandez 101.");
  });

  it("stock : dit combien de machines restent, épuisé à 0 ou moins", () => {
    expect(checkOrderCreation({ ...open, available: 2 }, 3)?.message).toBe("Il ne reste que 2 machines sur ce lot : vous en demandez 3.");
    expect(checkOrderCreation({ ...open, available: -1 }, 1)).toMatchObject({
      code: "out_of_stock",
      message: "Le stock du lot est épuisé.",
      extra: { details: { available: 0 } },
    });
  });
});

describe("settlementStep", () => {
  it("paiement complet non accepté : décider (accepter ou rembourser)", () => {
    expect(settlementStep({ ...balance, receivedSats: 100_000n, awaitingDecision: true })).toBe("decide");
  });

  it("excédent d'une facture payée, quel qu'en soit le montant : rien d'automatique (décision Hugo 2026-10-09)", () => {
    for (const extra of [1n, 300n, 2_000n, 20_000n, 10_000_000n]) {
      const b = { ...balance, status: "paid" as const, receivedSats: 100_000n + extra, refundDueSats: extra, unsettledSats: extra, overpaymentUnrefunded: true };
      expect(settlementStep(b), `${extra}`).toBe("none");
    }
  });

  it("jamais d'automatisme quand une décision humaine est attendue", () => {
    expect(settlementStep({ ...balance, status: "cancelled", needsAdminDecision: true, awaitingDecision: true })).toBe("none");
    expect(settlementStep({ ...balance, awaitingUserDecision: true })).toBe("none");
    expect(settlementStep({ ...balance, receivedSats: 50_000n })).toBe("none");
  });
});

describe("planUserRefund", () => {
  const partial = { ...balance, receivedSats: 30_000n, userRefundAllowed: true };

  it("rembourse le versement moins les frais réseau à la charge de l'utilisateur", () => {
    expect(planUserRefund(partial, 2_000n)).toEqual({ amountSats: 28_000n, networkFeeSats: 2_000n });
  });

  it("versement qui ne couvre pas les frais : 409 refund_below_network_fee (attendre l'appoint)", () => {
    const refused = planUserRefund({ ...partial, receivedSats: 2_000n }, 2_000n) as ApiError;
    expect(refused).toMatchObject({ status: 409, code: "refund_below_network_fee" });
    expect(refused.extra.details).toEqual({ receivedSats: "2000", networkFeeSats: "2000" });
  });

  it.each([
    [{ status: "refunded" as const }, "order_already_refunded"],
    [{ status: "paid" as const }, "refund_not_allowed"],
    [{ status: "cancelled" as const }, "refund_not_allowed"],
    [{ receivedSats: 0n, userRefundAllowed: false }, "order_nothing_received"],
    [{ receivedSats: 100_000n, userRefundAllowed: false }, "refund_not_allowed"],
    [{ batchOpen: false, userRefundAllowed: false }, "refund_not_allowed"],
  ])("refus %#", (patch, code) => {
    expect(planUserRefund({ ...partial, ...patch }, 2_000n)).toMatchObject({ code });
  });
});

describe("attentionOf / planAdminRefund", () => {
  it("facture annulée payée intégralement : accepter, ou rembourser l'annulation entière (motif au choix, paiement tardif compris)", () => {
    const b = { ...balance, status: "cancelled" as const, receivedSats: 100_000n, unsettledSats: 100_000n, needsAdminDecision: true };
    expect(attentionOf(b)).toMatchObject({
      reason: "admin_decision", canAccept: true, canRefund: true, refundCauses: ["admin_other", "shop_stock", "late_payment_no_room"],
    });
    expect(planAdminRefund(b)).toEqual({ kind: "cancellation", amountSats: 100_000n, causes: ["admin_other", "shop_stock", "late_payment_no_room"] });
  });

  it("facture annulée partiellement payée : pas d'acceptation, pas de motif « paiement tardif »", () => {
    const b = { ...balance, status: "cancelled" as const, receivedSats: 10n, unsettledSats: 10n, needsAdminDecision: true };
    expect(attentionOf(b)).toMatchObject({ canAccept: false, canRefund: true, refundCauses: ["admin_other", "shop_stock"] });
  });

  it("paiement reçu après un remboursement intégral : excédent, frais à l'utilisateur ou à la boutique au choix de l'admin", () => {
    const b = { ...balance, status: "refunded" as const, receivedSats: 130_000n, refundedSats: 100_000n, unsettledSats: 30_000n, needsAdminDecision: true };
    expect(planAdminRefund(b)).toEqual({ kind: "overpayment", amountSats: 30_000n, causes: ["overpayment", "admin_other"] });
  });

  it("choix de l'utilisateur attendu (réservation terminée) : l'admin peut rembourser après contact (paiement partiel)", () => {
    const b = {
      ...balance, status: "expired" as const, expiresAt: new Date(NOW.getTime() - 60_000), receivedSats: 10_000n, unsettledSats: 10_000n,
      awaitingUserDecision: true, userRefundAllowed: true,
    };
    expect(attentionOf(b)).toMatchObject({ reason: "user_decision", canAccept: false, canRefund: true, refundCauses: ["partial_payment", "admin_other"] });
    expect(planAdminRefund(b)).toEqual({ kind: "cancellation", amountSats: 10_000n, causes: ["partial_payment", "admin_other"] });
  });

  it("paiement partiel, réservation en cours : seul l'utilisateur choisit (409 order_reservation_running)", () => {
    const b = { ...balance, receivedSats: 10_000n, unsettledSats: 10_000n, userRefundAllowed: true };
    expect(attentionOf(b)).toBeNull();
    const refused = planAdminRefund(b) as ApiError;
    expect(refused).toMatchObject({ status: 409, code: "order_reservation_running" });
    expect(refused.extra.details).toEqual({ expiresAt: b.expiresAt.toISOString() });
  });

  it("paiement complet non traité : accepter seulement ; « plus de place » dit quand", () => {
    const b = { ...balance, receivedSats: 100_000n, awaitingDecision: true, fitsStock: true };
    expect(attentionOf(b)).toMatchObject({ reason: "awaiting_decision", canAccept: true, canRefund: false, refundCauses: [] });
    expect(planAdminRefund(b)).toMatchObject({ code: "payment_must_be_accepted" });
    expect(attentionOf({ ...b, fitsStock: false })!.label).toContain("ne tient plus dans le stock");
    const expired = { ...b, fitsStock: false, expiresAt: new Date(NOW.getTime() - 1) };
    expect(attentionOf(expired)).toMatchObject({ canAccept: true, label: expect.stringContaining("plus de place") });
  });

  it("facture annulée d'un lot qui n'accepte plus de commande : rembourser, jamais « attendre l'appoint puis accepter »", () => {
    const b = {
      ...balance, status: "cancelled" as const, batchOpen: false, receivedSats: 100_000n, unsettledSats: 100_000n, needsAdminDecision: true,
    };
    expect(attentionOf(b)).toMatchObject({
      reason: "admin_decision", canAccept: false, canRefund: true, refundCauses: ["admin_other", "shop_stock", "late_payment_no_room"],
      label: expect.stringContaining("lot qui n'accepte plus de commande"),
    });
    const partial = { ...b, receivedSats: 10n, unsettledSats: 10n };
    expect(attentionOf(partial)).toMatchObject({ canAccept: false, label: expect.not.stringContaining("appoint") });
  });

  it("excédent d'une facture payée resté sans remboursement : l'admin décide, quel qu'en soit le montant (v5h)", () => {
    const b = {
      ...balance, status: "paid" as const, receivedSats: 100_300n, refundDueSats: 300n, unsettledSats: 300n, overpaymentUnrefunded: true,
    };
    expect(attentionOf(b)).toMatchObject({ reason: "overpayment_decision", canAccept: false, canRefund: true, refundCauses: ["admin_other", "overpayment"] });
    expect(planAdminRefund(b)).toEqual({ kind: "overpayment", amountSats: 300n, causes: ["admin_other", "overpayment"] });
  });

  it("remboursement sans adresse : contacter, rien à rembourser", () => {
    expect(attentionOf({ ...balance, status: "paid", refundAddressMissing: true })).toMatchObject({
      reason: "refund_address_missing", canRefund: false, refundCauses: [],
    });
  });

  it("rien à traiter", () => {
    expect(attentionOf(balance)).toBeNull();
    expect(planAdminRefund(balance)).toMatchObject({ code: "order_nothing_to_refund" });
  });

  it("motif choisi par l'admin : parmi ceux permis, sinon 422 refund_cause_not_allowed", () => {
    expect(checkRefundCause(["overpayment", "admin_other"], "overpayment")).toBeNull();
    const refused = checkRefundCause(["overpayment", "admin_other"], "shop_stock") as ApiError;
    expect(refused).toMatchObject({ status: 422, code: "refund_cause_not_allowed" });
    expect(refused.extra.details).toEqual({ allowedCauses: "overpayment,admin_other" });
    expect(refused.message).toContain("« Excédent de paiement »");
  });
});

describe("checkUserRenounce", () => {
  const paid = { ...balance, status: "paid" as const, userRenounceAllowed: true };

  it("commande payée d'un lot au plus en Précommande : permis", () => {
    expect(checkUserRenounce(paid)).toBeNull();
  });

  it.each([
    [{ status: "pending_payment" as const, userRenounceAllowed: false }, 409, "order_not_paid"],
    [{ status: "refunded" as const, userRenounceAllowed: false }, 409, "order_not_paid"],
    [{ userRenounceAllowed: false }, 409, "order_renounce_closed"],
  ])("refus %#", (patch, status, code) => {
    expect(checkUserRenounce({ ...paid, ...patch })).toMatchObject({ status, code });
  });
});

describe("planLineCancellation", () => {
  const lines = [
    { id: "a", amount: 50_000n },
    { id: "b", amount: 57_500n },
  ];

  it("toutes les machines actives par défaut", () => {
    expect(planLineCancellation(lines, undefined)).toEqual({ lineIds: ["a", "b"], amount: 107_500n, whole: true });
  });

  it("une partie des machines", () => {
    expect(planLineCancellation(lines, ["b"])).toEqual({ lineIds: ["b"], amount: 57_500n, whole: false });
  });

  it("machine inconnue ou déjà remboursée, ou plus rien à annuler", () => {
    expect(planLineCancellation(lines, ["c"])).toMatchObject({ status: 422, code: "unknown_order_line" });
    expect(planLineCancellation([], undefined)).toMatchObject({ code: "order_nothing_to_refund" });
  });
});

describe("planDismissal (classer sans suite)", () => {
  const FEE = 2_000n;
  const paidExcess = { ...balance, status: "paid" as const, receivedSats: 101_500n, unsettledSats: 1_500n, overpaymentUnrefunded: true };
  const code = (r: unknown) => (r instanceof ApiError ? r.code : null);

  it("excédent au plus égal aux frais, facture payée, remboursée ou annulée : tout le non-affecté", () => {
    expect(planDismissal(paidExcess, FEE)).toEqual({ sats: 1_500n });
    expect(planDismissal({ ...paidExcess, unsettledSats: FEE }, FEE)).toEqual({ sats: FEE });
    expect(planDismissal({ ...paidExcess, status: "refunded", needsAdminDecision: true }, FEE)).toEqual({ sats: 1_500n });
    expect(planDismissal({ ...paidExcess, status: "cancelled", needsAdminDecision: true }, FEE)).toEqual({ sats: 1_500n });
  });

  it("au-delà des frais : 409 excess_above_network_fee, avec les montants", () => {
    const refused = planDismissal({ ...paidExcess, unsettledSats: FEE + 1n }, FEE);
    expect(code(refused)).toBe("excess_above_network_fee");
    expect((refused as ApiError).extra.details).toEqual({ unsettledSats: "2001", networkFeeSats: "2000" });
  });

  it("une seule fois par facture : un versement arrivé après un classement se rembourse", () => {
    expect(code(planDismissal({ ...paidExcess, dismissedSats: 300n }, FEE))).toBe("excess_already_dismissed");
  });

  it("rien à classer, ou facture en attente ou expirée : 409 nothing_to_dismiss", () => {
    expect(code(planDismissal({ ...paidExcess, unsettledSats: 0n }, FEE))).toBe("nothing_to_dismiss");
    expect(code(planDismissal({ ...balance, receivedSats: 500n, unsettledSats: 500n }, FEE))).toBe("nothing_to_dismiss");
    expect(code(planDismissal({ ...balance, status: "expired", receivedSats: 500n, unsettledSats: 500n }, FEE))).toBe("nothing_to_dismiss");
  });

  it("une facture annulée dont des sats sont classés ne s'accepte plus", () => {
    const cancelled = { ...balance, status: "cancelled" as const, receivedSats: 100_000n, unsettledSats: 100_000n, needsAdminDecision: true };
    expect(attentionOf(cancelled)?.canAccept).toBe(true);
    expect(attentionOf({ ...cancelled, dismissedSats: 500n })?.canAccept).toBe(false);
  });
});

describe("resolveContactEmail", () => {
  it("e-mail saisi, mémorisé sur le profil s'il en diffère (casse comprise)", () => {
    expect(resolveContactEmail("a@b.fr", null)).toEqual({ email: "a@b.fr", remember: true });
    expect(resolveContactEmail("a@b.fr", "a@b.fr")).toEqual({ email: "a@b.fr", remember: false });
    expect(resolveContactEmail("A@b.fr", "a@b.fr")).toEqual({ email: "A@b.fr", remember: true });
  });

  it("sans saisie : celui du profil ; aucun : 422 contact_email_required", () => {
    expect(resolveContactEmail(null, "a@b.fr")).toEqual({ email: "a@b.fr", remember: false });
    const refused = resolveContactEmail(null, null);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(422);
    expect((refused as ApiError).code).toBe("contact_email_required");
  });
});
