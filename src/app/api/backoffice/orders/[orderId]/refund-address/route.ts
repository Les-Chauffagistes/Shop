import { requireBackoffice } from "@/server/auth";
import { setAdminRefundAddress } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { orderNotFound, refundAddressInput } from "@/server/orders";

type Context = { params: Promise<{ orderId: string }> };

/** L'admin donne, change ou efface l'adresse de remboursement d'une facture (journalisé). */
export const PATCH = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const orderId = await pathId(params, "orderId", orderNotFound());
  return json(await setAdminRefundAddress(orderId, await readJson(request, refundAddressInput), user));
});
