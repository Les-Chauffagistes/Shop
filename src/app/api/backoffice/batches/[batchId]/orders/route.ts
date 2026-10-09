import { requireBackoffice } from "@/server/auth";
import { listBatchOrders } from "@/server/backoffice-orders";
import { batchNotFound } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId } from "@/server/http";

type Context = { params: Promise<{ batchId: string }> };

/** Factures d'un lot. */
export const GET = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  return json(await listBatchOrders(await pathId(params, "batchId", batchNotFound())));
});
