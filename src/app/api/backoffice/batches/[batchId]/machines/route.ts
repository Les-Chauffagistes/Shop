import { requireBackoffice } from "@/server/auth";
import { batchNotFound } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId } from "@/server/http";
import { getBatchMachines } from "@/server/machines";

type Context = { params: Promise<{ batchId: string }> };

/** Machines et commandes payées d'un lot, avec le résumé batch_machine_summary. */
export const GET = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  return json(await getBatchMachines(await pathId(params, "batchId", batchNotFound())));
});
