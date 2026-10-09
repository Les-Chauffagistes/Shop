import { requireBackoffice } from "@/server/auth";
import { createOptionValue, optionNotFound, optionValueInput } from "@/server/catalog";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ optionId: string }> };

export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const optionId = await pathId(params, "optionId", optionNotFound());
  return json(await createOptionValue(optionId, await readJson(request, optionValueInput)), 201);
});
