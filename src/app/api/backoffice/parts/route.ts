import { requireBackoffice } from "@/server/auth";
import { createPart, listParts, partInput } from "@/server/catalog";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";

export const GET = withErrorHandling(async () => {
  await requireBackoffice();
  return json(await listParts());
});

export const POST = withErrorHandling(async (request: Request) => {
  await requireBackoffice();
  return json(await createPart(await readJson(request, partInput)), 201);
});
