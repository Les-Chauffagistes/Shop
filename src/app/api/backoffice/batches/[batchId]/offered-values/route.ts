import { requireBackoffice } from "@/server/auth";
import { batchNotFound, offerOptionValue, offerValueInput } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ batchId: string }> };

/** « Proposer sur ce lot » une valeur ajoutée au catalogue après la publication ; renvoie le lot à jour. */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const batchId = await pathId(params, "batchId", batchNotFound());
  return json(await offerOptionValue(batchId, await readJson(request, offerValueInput)), 201);
});
