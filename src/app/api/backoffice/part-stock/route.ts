import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json } from "@/server/http";
import { listPartStock } from "@/server/part-stock";

/** Vue d'ensemble des produits d'options : stock commun, demande, pression. */
export const GET = withErrorHandling(async () => {
  await requireBackoffice();
  return json(await listPartStock());
});
