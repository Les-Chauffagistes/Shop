import { requireBackoffice } from "@/server/auth";
import { deleteOption, optionNotFound, optionPatch, updateOption } from "@/server/catalog";
import { withErrorHandling } from "@/server/errors";
import { json, noContent, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ optionId: string }> };

export const PATCH = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const optionId = await pathId(params, "optionId", optionNotFound());
  return json(await updateOption(optionId, await readJson(request, optionPatch)));
});

export const DELETE = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  await deleteOption(await pathId(params, "optionId", optionNotFound()));
  return noContent();
});
