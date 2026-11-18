import type { NextRequest } from "next/server";
import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json } from "@/server/http";
import { listMachines, machineListQuery } from "@/server/machines";

/** Machines filtrées (lot, modèle, statuts, recherche par numéro de série), paginées. */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireBackoffice();
  return json(await listMachines(machineListQuery.parse(Object.fromEntries(request.nextUrl.searchParams))));
});
