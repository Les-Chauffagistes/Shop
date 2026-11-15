import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { hashboardsInput, machineNotFound, setHashboards } from "@/server/machines";

type Context = { params: Promise<{ machineId: string }> };

/** Saisie ou correction de hashboards, une par une, sans changer l'état fonctionnel. */
export const PUT = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const machineId = await pathId(params, "machineId", machineNotFound());
  return json(await setHashboards(machineId, await readJson(request, hashboardsInput), user));
});
