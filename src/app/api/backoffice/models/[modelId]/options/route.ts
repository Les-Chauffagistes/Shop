import { requireBackoffice } from "@/server/auth";
import { createOption, modelNotFound, optionInput } from "@/server/catalog";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ modelId: string }> };

export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const modelId = await pathId(params, "modelId", modelNotFound());
  return json(await createOption(modelId, await readJson(request, optionInput)), 201);
});
