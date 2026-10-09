import { requireBackoffice } from "@/server/auth";
import { dismissExcess, dismissExcessInput } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { orderNotFound } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

/** Classer sans suite les sats reçus non affectés d'une facture (au plus les frais réseau, une fois). */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const orderId = await pathId(params, "orderId", orderNotFound());
  return json(await dismissExcess(orderId, await readJson(request, dismissExcessInput), user));
});
