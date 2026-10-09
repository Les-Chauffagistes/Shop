import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";
import { createOrder, listOrders, orderInput, orderListQuery } from "@/server/orders";

/** Factures de l'utilisateur connecté. */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await requireUser();
  const query = orderListQuery.parse(Object.fromEntries(request.nextUrl.searchParams));
  return json(await listOrders(user.id, query));
});

/** Crée une facture (précommande ou commande) sur un lot ouvert aux commandes. */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await requireUser();
  return json(await createOrder(user.id, await readJson(request, orderInput)), 201);
});
