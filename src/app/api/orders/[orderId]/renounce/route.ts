import { requireUser } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { orderNotFound, renounceInput, renounceOrder } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

/** Renoncer à des machines (ou à toute) d'une commande payée, lot au plus en Précommande ; frais réseau à sa charge. */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireUser();
  const orderId = await pathId(params, "orderId", orderNotFound());
  return json(await renounceOrder(user.id, orderId, await readJson(request, renounceInput)));
});
