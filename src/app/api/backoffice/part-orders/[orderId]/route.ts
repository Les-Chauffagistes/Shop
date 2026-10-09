import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { partOrderNotFound, partOrderPatch, updatePartOrder } from "@/server/part-stock";

type Context = { params: Promise<{ orderId: string }> };

/** Fait avancer une commande de produit (livraison = statut + réception au stock, en une transaction). */
export const PATCH = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const orderId = await pathId(params, "orderId", partOrderNotFound());
  return json(await updatePartOrder(orderId, await readJson(request, partOrderPatch), user));
});
