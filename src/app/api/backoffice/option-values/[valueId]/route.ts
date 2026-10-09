import { requireBackoffice } from "@/server/auth";
import { deleteOptionValue, optionValueNotFound, optionValuePatch, updateOptionValue } from "@/server/catalog";
import { withErrorHandling } from "@/server/errors";
import { json, pathId, readJson } from "@/server/http";

type Context = { params: Promise<{ valueId: string }> };

export const PATCH = withErrorHandling(async (request: Request, { params }: Context) => {
  await requireBackoffice();
  const valueId = await pathId(params, "valueId", optionValueNotFound());
  return json(await updateOptionValue(valueId, await readJson(request, optionValuePatch)));
});

/** Renvoie le menu mis à jour (200), pas 204 : l'UI réaffiche les valeurs restantes. */
export const DELETE = withErrorHandling(async (_request: Request, { params }: Context) => {
  await requireBackoffice();
  return json(await deleteOptionValue(await pathId(params, "valueId", optionValueNotFound())));
});
