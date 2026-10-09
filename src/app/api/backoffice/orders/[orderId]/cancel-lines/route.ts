import { requireBackoffice } from "@/server/auth";
import { cancelLinesInput, cancelPaidLines } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { orderNotFound } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

/** Annuler des machines d'une commande payée, remboursées au prorata (frais à la charge de la boutique). */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const orderId = await pathId(params, "orderId", orderNotFound());
  return json(await cancelPaidLines(orderId, await readJson(request, cancelLinesInput), user));
});
