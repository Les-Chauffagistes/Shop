import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, pgFailureOf, toErrorResponse, withErrorHandling } from "@/server/errors";

// Formes réelles relevées avec Prisma 7 + PrismaPg sur la base du projet.
function knownRequestError(cause: Record<string, unknown>) {
  return Object.assign(new Error("Invalid `prisma.x.create()` invocation: … Failing row contains (Alice, 1 rue …)"), {
    name: "PrismaClientKnownRequestError",
    code: "P2039",
    meta: { driverAdapterError: { name: "DriverAdapterError", cause } },
  });
}
function deferredTriggerError(cause: Record<string, unknown>) {
  return Object.assign(new Error(String(cause.originalMessage)), { name: "DriverAdapterError", cause });
}

const uniqueViolation = knownRequestError({
  originalCode: "23505",
  originalMessage: 'duplicate key value violates unique constraint "Order_payment_address_key"',
  kind: "UniqueConstraintViolation",
  constraint: { index: "Order_payment_address_key" },
});
const checkViolation = knownRequestError({
  originalCode: "23514",
  originalMessage: 'new row for relation "Model" violates check constraint "Model_hashrate_check"',
  kind: "postgres",
  detail: "Failing row contains (…)",
});

async function bodyOf(response: Response) {
  return { status: response.status, body: await response.json() };
}

afterEach(() => vi.restoreAllMocks());

describe("pgFailureOf", () => {
  it("lit la contrainte d'un index unique", () => {
    expect(pgFailureOf(uniqueViolation)).toEqual({ sqlstate: "23505", constraint: "Order_payment_address_key" });
  });

  it("lit la contrainte CHECK dans le message", () => {
    expect(pgFailureOf(checkViolation)).toEqual({ sqlstate: "23514", constraint: "Model_hashrate_check" });
  });

  it("lit une erreur de trigger différé levée au COMMIT", () => {
    const error = deferredTriggerError({
      originalCode: "23514",
      originalMessage: 'Batch 1 oversold (constraint "Batch_stock")',
      kind: "postgres",
    });
    expect(pgFailureOf(error)).toEqual({ sqlstate: "23514", constraint: "Batch_stock" });
  });

  it("ignore les erreurs qui ne viennent pas de Postgres", () => {
    expect(pgFailureOf(new Error("boom"))).toBeNull();
    expect(pgFailureOf("boom")).toBeNull();
  });
});

describe("toErrorResponse", () => {
  it("renvoie une ApiError telle quelle", async () => {
    expect(await bodyOf(toErrorResponse(new ApiError(403, "forbidden", "Accès réservé au backoffice.")))).toEqual({
      status: 403,
      body: { error: { code: "forbidden", message: "Accès réservé au backoffice." } },
    });
  });

  it("traduit une contrainte métier connue", async () => {
    const { status, body } = await bodyOf(toErrorResponse(uniqueViolation));
    expect(status).toBe(409);
    expect(body.error.code).toBe("payment_address_taken");
  });

  it("traduit une contrainte de trigger connue", async () => {
    const error = deferredTriggerError({
      originalCode: "23514",
      originalMessage: 'Batch 1 oversold (constraint "Batch_stock")',
      kind: "postgres",
    });
    expect((await bodyOf(toErrorResponse(error))).body.error.code).toBe("out_of_stock");
  });

  it("traduit les contraintes du schéma v4 (catalogue figé, stock d'options)", async () => {
    const codes = Object.fromEntries(
      await Promise.all(
        [
          "OptionValue_default_free_check",
          "OptionValue_price_frozen",
          "OptionValue_default_change_locked",
          "OptionValue_toggle_default_fixed",
          "BatchOptionValue_snapshot",
          "ConfigurationItem_option_hidden",
          "Part_stock_non_negative",
          "BatchPartOrder_reception",
          "Wishlist_configuration_frozen",
          "Wishlist_converted",
        ].map(async (constraint) => {
          const error = deferredTriggerError({
            originalCode: "23514",
            originalMessage: `rule broken (constraint "${constraint}")`,
            kind: "postgres",
          });
          const reply = await bodyOf(toErrorResponse(error));
          return [constraint, [reply.body.error.code, reply.status]];
        }),
      ),
    );
    expect(codes).toEqual({
      OptionValue_default_free_check: ["default_value_not_free", 422],
      OptionValue_price_frozen: ["option_price_frozen", 409],
      OptionValue_default_change_locked: ["default_change_locked", 409],
      OptionValue_toggle_default_fixed: ["toggle_default_fixed", 409],
      BatchOptionValue_snapshot: ["batch_option_values_frozen", 409],
      ConfigurationItem_option_hidden: ["option_hidden", 409],
      Part_stock_non_negative: ["part_stock_insufficient", 409],
      BatchPartOrder_reception: ["part_order_reception_required", 409],
      Wishlist_configuration_frozen: ["wishlist_not_editable", 409],
      Wishlist_converted: ["wishlist_converted", 409],
    });
  });

  it("renvoie les éléments qui bloquent une opération", async () => {
    const blockers = [{ kind: "batch" as const, id: "b1", label: "10 S19 (Sondage)" }];
    expect(await bodyOf(toErrorResponse(new ApiError(409, "model_in_use", "Utilisé.", blockers)))).toEqual({
      status: 409,
      body: { error: { code: "model_in_use", message: "Utilisé.", blockers } },
    });
  });

  it("retombe sur le SQLSTATE pour une contrainte sans mapping, sans fuite", async () => {
    const response = toErrorResponse(checkViolation);
    const text = await response.text();
    expect(response.status).toBe(422);
    expect(JSON.parse(text).error.code).toBe("constraint_violation");
    expect(text).not.toMatch(/Model_hashrate_check|Failing row|Alice|prisma/);
  });

  it("liste les champs invalides d'une ZodError sans recopier la saisie", async () => {
    const parsed = z.object({ quantity: z.number().int().positive() }).safeParse({ quantity: -4 });
    const { status, body } = await bodyOf(toErrorResponse(parsed.error));
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.issues).toEqual([{ path: "quantity", message: expect.any(String) }]);
    expect(JSON.stringify(body)).not.toContain("-4");
  });

  it("masque une erreur inattendue et ne journalise ni message ni stack", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await bodyOf(toErrorResponse(new Error("adresse alice@example.com")));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "internal", message: expect.any(String) } });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][0])).not.toContain("alice");
  });
});

describe("withErrorHandling", () => {
  it("convertit l'erreur levée par le handler", async () => {
    const handler = withErrorHandling(async () => {
      throw new ApiError(401, "unauthenticated", "Vous devez être connecté.");
    });
    expect((await handler()).status).toBe(401);
  });

  it("laisse passer une réponse normale", async () => {
    const handler = withErrorHandling(async (id: string) => Response.json({ id }));
    expect(await (await handler("x")).json()).toEqual({ id: "x" });
  });
});

describe("contraintes des factures (schéma v5 à v5f)", () => {
  const trigger = (name: string) =>
    deferredTriggerError({ originalCode: "23514", originalMessage: `refused (constraint "${name}")`, kind: "postgres" });

  it.each([
    ["Order_priority_window", 409, "order_priority_window"],
    ["OrderLine_priority_quota", 409, "order_priority_quota"],
    ["Order_one_live_per_user_batch", 409, "order_already_pending"],
    ["Order_abandoned_cooldown", 429, "order_cooldown"],
    ["Order_abandoned_limit", 409, "order_creation_blocked"],
    ["Order_max_lines", 422, "order_too_many_lines"],
    ["Wishlist_cap", 409, "wishlist_limit_reached"],
    ["OrderLine_wishlist_live", 409, "wishlist_withdrawn"],
    ["OrderLine_order_id_wishlist_id_key", 409, "wishlist_duplicated"],
    ["Order_paid_in_full_check", 409, "order_not_paid_in_full"],
    ["Order_refunded_payment_check", 409, "order_nothing_received"],
    ["Order_expected_sats_check", 422, "order_amount_invalid"],
    ["Order_received_sats_check", 422, "order_amount_invalid"],
    ["Order_payment_address_check", 422, "order_amount_invalid"],
    ["Order_payment_address_key", 409, "payment_address_taken"],
    ["Order_status_transition", 409, "order_status_invalid"],
    ["Order_status_dates_check", 422, "order_status_invalid"],
    ["Order_cancel_unpaid", 409, "order_cancel_paid"],
    ["Order_cancel_expired", 409, "order_cancel_expired"],
    ["Order_batch_open", 409, "batch_not_open"],
    ["Order_late_payment_refund", 409, "payment_must_be_accepted"],
    ["Order_refunded_in_full", 422, "refund_incomplete"],
    ["Order_refunds", 422, "refund_amount_invalid"],
    ["Payment_txid_vout_key", 409, "payment_duplicate"],
    ["Payment_amount_sats_check", 422, "payment_invalid"],
    ["Payment_txid_check", 422, "payment_invalid"],
    ["Payment_vout_check", 422, "payment_invalid"],
    ["Refund_kind_check", 422, "refund_invalid"],
    ["Refund_kind_lines", 422, "refund_invalid"],
    ["Refund_prorata", 422, "refund_prorata"],
    ["Refund_overpayment", 422, "refund_overpayment_exceeded"],
    ["Refund_network_fee_sats_check", 422, "refund_invalid"],
    ["Refund_amount_sats_check", 422, "refund_invalid"],
    ["Refund_reason_check", 422, "invalid_input"],
    ["Refund_partial_payment_allowed", 409, "refund_not_allowed"],
    ["Refund_user_net_positive", 409, "refund_below_network_fee"],
    ["Refund_partial_payment_after_expiry", 409, "order_reservation_running"],
    ["Refund_user_renounce_paid", 409, "order_not_paid"],
    ["Refund_user_renounce_window", 409, "order_renounce_closed"],
    ["Order_refund_address_check", 422, "invalid_refund_address"],
    ["Refund_destination_address_check", 422, "invalid_refund_address"],
    ["Order_refund_address_ours", 422, "refund_address_ours"],
    ["Refund_destination_ours", 422, "refund_address_ours"],
    ["Order_refund_address_frozen", 409, "refund_address_frozen"],
    ["Refund_sent_destination", 409, "refund_destination_changed"],
    ["Refund_sent_frozen", 409, "refund_already_sent"],
    ["Refund_sent_check", 422, "refund_address_missing"],
    ["Refund_reference_check", 422, "invalid_refund_reference"],
    ["OrderBlockRelease_released_by_check", 422, "block_release_invalid"],
    ["OrderBlockRelease_reason_check", 422, "block_release_invalid"],
    ["ShopSettings_single_row_check", 422, "shop_settings_invalid"],
    ["ShopSettings_wishlist_max_check", 422, "shop_settings_invalid"],
    ["ShopSettings_order_max_lines_check", 422, "shop_settings_invalid"],
    ["ShopSettings_cooldown_check", 422, "shop_settings_invalid"],
    ["ShopSettings_abandoned_limit_check", 422, "shop_settings_invalid"],
    ["ShopSettings_abandoned_window_check", 422, "shop_settings_invalid"],
    ["Address_frozen", 409, "address_frozen"],
  ])("%s → %i %s", async (name, status, code) => {
    const reply = await bodyOf(toErrorResponse(trigger(name)));
    expect({ status: reply.status, code: reply.body.error.code }).toEqual({ status, code });
  });

  it.each([
    "Order_immutable",
    "Order_received_via_payment",
    "Order_no_delete",
    "OrderLine_no_delete",
    "Payment_append_only",
    "ShopSettings_no_delete",
    "ShopSettings_required",
    "OrderBlockRelease_append_only",
    "Refund_immutable",
    "Order_status_lines",
    "OrderLine_order_id_position_key",
    "OrderLine_position_check",
    "Refund_cause_fee_payer",
    "Refund_system_above_fee",
    "Refund_late_payment_full",
    "Refund_cause_check",
    "Refund_fee_payer_check",
    "Refund_fee_single_line_check",
    "Refund_cause_remainder",
    "Refund_admin_traced_check",
    "Refund_sent_by_check",
    "OrderRefundAddressChange_actor",
    "OrderRefundAddressChange_actor_user",
    "OrderRefundAddressChange_append_only",
    "OrderRefundAddressChange_changed_check",
    "OrderRefundAddressChange_actor_auth_user_id_check",
  ])("%s est un bug du serveur : 500 journalisé", async (name) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await bodyOf(toErrorResponse(trigger(name)))).status).toBe(500);
    expect(log).toHaveBeenCalledOnce();
  });

  it("délai : 429 avec Retry-After (secondes, arrondi supérieur) et détails structurés", async () => {
    const response = toErrorResponse(
      new ApiError(429, "order_cooldown", "Réessayez à 14:35.", undefined, {
        details: { cooldownEndsAt: "2026-10-07T12:35:00.000Z" },
        retryAfterSeconds: 89.2,
      }),
    );
    expect(response.headers.get("retry-after")).toBe("90");
    expect(await response.json()).toEqual({
      error: { code: "order_cooldown", message: "Réessayez à 14:35.", details: { cooldownEndsAt: "2026-10-07T12:35:00.000Z" } },
    });
  });
});
