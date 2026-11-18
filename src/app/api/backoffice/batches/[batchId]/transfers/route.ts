import { requireBackoffice } from "@/server/auth";
import { batchNotFound, transferInput, transferToStock } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ batchId: string }> };

/** Transfère des machines de la palette vers le lot de stock de son modèle ; renvoie la palette à jour. */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const batchId = await pathId(params, "batchId", batchNotFound());
  return json(await transferToStock(batchId, await readJson(request, transferInput), user), 201);
});
