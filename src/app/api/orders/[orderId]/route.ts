import { requireUser } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, pathId } from "@/server/http";
import { getOrder, orderNotFound } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

/** Une facture de l'utilisateur (suivi : statut, paiements, remboursements). */
export const GET = withErrorHandling(async (_request: Request, { params }: Context) => {
  const user = await requireUser();
  return json(await getOrder(user.id, await pathId(params, "orderId", orderNotFound())));
});
