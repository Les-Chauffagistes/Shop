import { requireBackoffice } from "@/server/auth";
import { acceptOrder } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { emptyInput, orderNotFound } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

/** Accepter une facture « à traiter » (corps `{}`). */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const orderId = await pathId(params, "orderId", orderNotFound());
  await readJson(request, emptyInput);
  return json(await acceptOrder(orderId));
});
