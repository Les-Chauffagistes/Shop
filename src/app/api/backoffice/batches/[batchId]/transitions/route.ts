import { requireBackoffice } from "@/server/auth";
import { batchNotFound, changeBatchStatus, transitionInput } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ batchId: string }> };

/** Change le statut du lot (insère une transition au journal) ; renvoie le lot à jour. */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const batchId = await pathId(params, "batchId", batchNotFound());
  return json(await changeBatchStatus(batchId, await readJson(request, transitionInput), user), 201);
});
