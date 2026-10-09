import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json } from "@/server/http";
import { getOrderingStatus, orderingQuery } from "@/server/orders";

/** Ce que l'utilisateur peut commander maintenant sur un lot (priorité, délai, blocage, facture en cours). */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await requireUser();
  const { batchId } = orderingQuery.parse(Object.fromEntries(request.nextUrl.searchParams));
  return json(await getOrderingStatus(user.id, batchId));
});
