import type { NextRequest } from "next/server";
import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json } from "@/server/http";
import { customerSearchQuery, searchCustomers } from "@/server/manual-sales";

/** Recherche d'un client par e-mail parmi les comptes existants, pour une vente manuelle. */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireBackoffice();
  return json(await searchCustomers(customerSearchQuery.parse(Object.fromEntries(request.nextUrl.searchParams))));
});
