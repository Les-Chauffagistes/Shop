import { requireBackoffice } from "@/server/auth";
import { batchNotFound, listRestocks, restockBatch, restockInput } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ batchId: string }> };

/** Réassorts d'un lot de stock, du plus ancien au plus récent. */
export const GET = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  return json(await listRestocks(await pathId(params, "batchId", batchNotFound())));
});

/** Réassort d'un lot de stock : la base crée les machines attendues ; renvoie le lot à jour. */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const batchId = await pathId(params, "batchId", batchNotFound());
  return json(await restockBatch(batchId, await readJson(request, restockInput), user), 201);
});
