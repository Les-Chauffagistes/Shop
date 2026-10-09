import { requireUser } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { orderNotFound, requestUserRefund, userRefundInput } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

/** Remboursement d'un paiement partiel, frais réseau à la charge de l'utilisateur. */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireUser();
  const orderId = await pathId(params, "orderId", orderNotFound());
  return json(await requestUserRefund(user.id, orderId, await readJson(request, userRefundInput)));
});
