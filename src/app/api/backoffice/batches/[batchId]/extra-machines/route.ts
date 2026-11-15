import { requireBackoffice } from "@/server/auth";
import { batchNotFound } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { extraMachinesInput, receiveExtraMachines } from "@/server/machines";

type Context = { params: Promise<{ batchId: string }> };

/** Machines reçues en plus de la palette : créées reçues au lot de stock du modèle (origine : la palette). */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const batchId = await pathId(params, "batchId", batchNotFound());
  return json(await receiveExtraMachines(batchId, await readJson(request, extraMachinesInput), user), 201);
});
