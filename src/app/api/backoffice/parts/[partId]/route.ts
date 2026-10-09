import { requireBackoffice } from "@/server/auth";
import { deletePart, partNotFound, partPatch, updatePart } from "@/server/catalog";
import { withErrorHandling } from "@/server/errors";
import { json, noContent, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ partId: string }> };

export const PATCH = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const partId = await pathId(params, "partId", partNotFound());
  return json(await updatePart(partId, await readJson(request, partPatch)));
});

export const DELETE = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  await deletePart(await pathId(params, "partId", partNotFound()));
  return noContent();
});
