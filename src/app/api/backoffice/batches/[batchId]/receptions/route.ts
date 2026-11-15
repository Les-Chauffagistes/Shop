import { requireBackoffice } from "@/server/auth";
import { batchNotFound } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { receiveMachines, receptionInput } from "@/server/machines";

type Context = { params: Promise<{ batchId: string }> };

/** Réception en bloc des machines attendues du lot (numéros de série collés facultatifs). */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const batchId = await pathId(params, "batchId", batchNotFound());
  return json(await receiveMachines(batchId, await readJson(request, receptionInput), user), 201);
});
