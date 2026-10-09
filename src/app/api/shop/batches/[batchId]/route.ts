import { batchNotFound } from "@/server/batches";
import { withErrorHandling } from "@/server/errors";
import { json, pathId } from "@/server/http";
import { getPublicBatch } from "@/server/shop";

type Context = { params: Promise<{ batchId: string }> };

/** Fiche produit publique d'un lot visible (sondage), avec les options proposées. */
export const GET = withErrorHandling(async (_request: Request, { params }: Context) =>
  json(await getPublicBatch(await pathId(params, "batchId", batchNotFound()))),
);
