import { requireUser } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { orderNotFound, refundAddressInput, setOwnRefundAddress } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

/** Donne, change ou efface l'adresse de remboursement d'une de ses factures (tant que rien n'est envoyé). */
export const PATCH = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireUser();
  const orderId = await pathId(params, "orderId", orderNotFound());
  return json(await setOwnRefundAddress(user.id, orderId, await readJson(request, refundAddressInput)));
});
