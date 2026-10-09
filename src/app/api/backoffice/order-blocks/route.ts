import type { NextRequest } from "next/server";
import { requireBackoffice } from "@/server/auth";
import { blockListQuery, listOrderBlocks } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json } from "@/server/http";

/** Utilisateurs bloqués sur un lot après trop de factures abandonnées. */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireBackoffice();
  return json(await listOrderBlocks(blockListQuery.parse(Object.fromEntries(request.nextUrl.searchParams))));
});
