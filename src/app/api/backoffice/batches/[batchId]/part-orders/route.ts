import { requireBackoffice } from "@/server/auth";
import { batchNotFound } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { createPartOrder, partOrderInput } from "@/server/part-stock";

type Context = { params: Promise<{ batchId: string }> };

/** Commande un produit d'option pour le lot (statut « Commande en cours »). */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const batchId = await pathId(params, "batchId", batchNotFound());
  return json(await createPartOrder(batchId, await readJson(request, partOrderInput)), 201);
});
