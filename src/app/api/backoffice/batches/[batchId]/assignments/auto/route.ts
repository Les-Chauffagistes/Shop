import { requireBackoffice } from "@/server/auth";
import { batchNotFound } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { autoAssign } from "@/server/machines";
import { emptyInput } from "@/server/orders";

type Context = { params: Promise<{ batchId: string }> };

/** Attribue les machines libres OK aux lignes payées sans machine, premier payé d'abord. */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const batchId = await pathId(params, "batchId", batchNotFound());
  await readJson(request, emptyInput);
  return json(await autoAssign(batchId, user), 201);
});
