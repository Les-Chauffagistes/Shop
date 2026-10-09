import { requireUser } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, noContent, pathId, readJson } from "@/server/http";
import { cancelWishlist, getWishlist, updateWishlist, wishlistNotFound, wishlistPatch } from "@/server/wishlists";

type Context = { params: Promise<{ wishlistId: string }> };

export const GET = withErrorHandling(async (_request: Request, { params }: Context) => {
  const user = await requireUser();
  return json(await getWishlist(user.id, await pathId(params, "wishlistId", wishlistNotFound())));
});

/** Change la configuration (nouvel instantané des prix). */
export const PATCH = withErrorHandling(async (request: Request, { params }: Context) => {
  const user = await requireUser();
  const wishlistId = await pathId(params, "wishlistId", wishlistNotFound());
  return json(await updateWishlist(user.id, wishlistId, await readJson(request, wishlistPatch)));
});

/** Retire la manifestation d'intérêt. */
export const DELETE = withErrorHandling(async (_request: Request, { params }: Context) => {
  const user = await requireUser();
  await cancelWishlist(user.id, await pathId(params, "wishlistId", wishlistNotFound()));
  return noContent();
});
