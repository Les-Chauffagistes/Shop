import type { NextRequest } from "next/server";
import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";
import { createCustomer, customerInput, customerSearchQuery, searchCustomers } from "@/server/manual-sales";

/** Recherche d'un client par e-mail (avec ou sans compte), pour une vente manuelle. */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireBackoffice();
  return json(await searchCustomers(customerSearchQuery.parse(Object.fromEntries(request.nextUrl.searchParams))));
});

/** Crée un client sans compte (e-mail obligatoire, adresse). */
export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireBackoffice();
  return json(await createCustomer(await readJson(request, customerInput), user), 201);
});
