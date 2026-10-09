import { requireBackoffice } from "@/server/auth";
import { partNotFound } from "@/server/catalog";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { createMovement, listMovements, movementInput } from "@/server/part-stock";

type Context = { params: Promise<{ partId: string }> };

export const GET = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  return json(await listMovements(await pathId(params, "partId", partNotFound())));
});

/** Réception hors commande, correction d'inventaire ou kit monté. */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const partId = await pathId(params, "partId", partNotFound());
  return json(await createMovement(partId, await readJson(request, movementInput), user), 201);
});
