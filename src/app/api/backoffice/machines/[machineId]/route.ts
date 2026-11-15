import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { getMachine, machineNotFound, machinePatch, updateMachine } from "@/server/machines";

type Context = { params: Promise<{ machineId: string }> };

/** Fiche d'une machine : journal des statuts, attributions, transferts. */
export const GET = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  return json(await getMachine(await pathId(params, "machineId", machineNotFound())));
});

/** Numéros de série, note, suivi du transporteur. */
export const PATCH = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const machineId = await pathId(params, "machineId", machineNotFound());
  return json(await updateMachine(machineId, await readJson(request, machinePatch)));
});
