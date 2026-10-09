import { requireBackoffice } from "@/server/auth";
import { deleteModel, getModel, modelNotFound, modelPatch, updateModel } from "@/server/catalog";
import { withErrorHandling } from "@/server/errors";
import { json, noContent, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ modelId: string }> };

export const GET = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  return json(await getModel(await pathId(params, "modelId", modelNotFound())));
});

export const PATCH = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const modelId = await pathId(params, "modelId", modelNotFound());
  return json(await updateModel(modelId, await readJson(request, modelPatch)));
});

export const DELETE = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  await deleteModel(await pathId(params, "modelId", modelNotFound()));
  return noContent();
});
