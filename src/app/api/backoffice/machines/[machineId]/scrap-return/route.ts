import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { machineNotFound, returnScrappedMachine, scrapReturnInput } from "@/server/machines";

type Context = { params: Promise<{ machineId: string }> };

/** Annule la mise au rebut d'une machine : retour « En stock » avec motif obligatoire (la machine reste défectueuse, à recontrôler). */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const machineId = await pathId(params, "machineId", machineNotFound());
  return json(await returnScrappedMachine(machineId, await readJson(request, scrapReturnInput), user), 201);
});
