import { requireBackoffice } from "@/server/auth";
import { discountInput, grantDiscount } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { orderNotFound } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

/** Rabais sur une commande payée : remboursement partiel sans annuler de machine (frais à la charge de la boutique). */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const orderId = await pathId(params, "orderId", orderNotFound());
  return json(await grantDiscount(orderId, await readJson(request, discountInput), user));
});
