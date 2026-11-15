import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { assignLine, assignmentInput, lineNotFound } from "@/server/machines";

type Context = { params: Promise<{ lineId: string }> };

/** Attribuer, remplacer ou retirer la machine d'une ligne payée. */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const lineId = await pathId(params, "lineId", lineNotFound());
  return json(await assignLine(lineId, await readJson(request, assignmentInput), user), 201);
});
