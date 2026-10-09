import { requireBackoffice } from "@/server/auth";
import { batchNotFound, batchPatch, getBatch, updateBatch } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ batchId: string }> };

export const GET = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  return json(await getBatch(await pathId(params, "batchId", batchNotFound())));
});

export const PATCH = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const batchId = await pathId(params, "batchId", batchNotFound());
  return json(await updateBatch(batchId, await readJson(request, batchPatch)));
});
