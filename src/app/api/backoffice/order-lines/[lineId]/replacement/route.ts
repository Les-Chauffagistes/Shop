import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";
import { lineNotFound, replaceLineMachine, replacementInput } from "@/server/machines";

type Context = { params: Promise<{ lineId: string }> };

/** Remplacer en un clic la machine d'une ligne (machine libre choisie par le serveur, sinon commande en trop remboursée). */
export const POST = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireBackoffice();
  const lineId = await pathId(params, "lineId", lineNotFound());
  return json(await replaceLineMachine(lineId, await readJson(request, replacementInput), user), 201);
});
