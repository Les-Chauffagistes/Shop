import { requireBackoffice } from "@/server/auth";
import { cancelPendingOrder } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { emptyInput, orderNotFound } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

/** Annule une facture en attente sans versement (corps `{}`) : cause `admin`, jamais un abandon du client. */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const orderId = await pathId(params, "orderId", orderNotFound());
  await readJson(request, emptyInput);
  return json(await cancelPendingOrder(orderId));
});
