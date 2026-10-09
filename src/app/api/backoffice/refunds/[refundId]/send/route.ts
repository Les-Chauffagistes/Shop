import { requireBackoffice } from "@/server/auth";
import { refundNotFound, sendRefund, sendRefundInput } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ refundId: string }> };

/** Enregistre l'envoi d'un remboursement (référence de la transaction, adresse vue par l'admin). */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const refundId = await pathId(params, "refundId", refundNotFound());
  return json(await sendRefund(refundId, await readJson(request, sendRefundInput), user));
});
