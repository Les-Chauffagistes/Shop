import { requireBackoffice } from "@/server/auth";
import { batchNotFound } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId } from "@/server/http";
import { getBatchPartNeeds } from "@/server/part-stock";

type Context = { params: Promise<{ batchId: string }> };

/** Besoin en produits d'options du lot, stock commun et pression, commandes de produits du lot. */
export const GET = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  return json(await getBatchPartNeeds(await pathId(params, "batchId", batchNotFound())));
});
