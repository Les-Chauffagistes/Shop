import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";
import { createWishlists, listWishlists, wishlistInput, wishlistListQuery } from "@/server/wishlists";

/** Manifestations d'intérêt actives de l'utilisateur connecté. */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await requireUser();
  const query = wishlistListQuery.parse(Object.fromEntries(request.nextUrl.searchParams));
  return json(await listWishlists(user.id, query));
});

/** Manifeste son intérêt pour une ou plusieurs machines d'un lot au sondage. */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await requireUser();
  return json(await createWishlists(user.id, await readJson(request, wishlistInput)), 201);
});
