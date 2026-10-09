import { requireBackoffice } from "@/server/auth";
import { createModel, listModels, modelInput } from "@/server/catalog";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";

export const GET = withErrorHandling(async () => {
  await requireBackoffice();
  return json(await listModels());
});

export const POST = withErrorHandling(async (request: Request) => {
  await requireBackoffice();
  return json(await createModel(await readJson(request, modelInput)), 201);
});
