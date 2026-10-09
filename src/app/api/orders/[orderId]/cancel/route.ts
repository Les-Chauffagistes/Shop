import { requireUser } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { cancelOrder, emptyInput, orderNotFound } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

/** Annule une facture en attente impayée (corps `{}`). */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireUser();
  const orderId = await pathId(params, "orderId", orderNotFound());
  await readJson(request, emptyInput);
  return json(await cancelOrder(user.id, orderId));
});
