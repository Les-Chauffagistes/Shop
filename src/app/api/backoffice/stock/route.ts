import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json } from "@/server/http";
import { listModelStock } from "@/server/machines";

/** Stock par modèle (vue model_stock_summary). */
export const GET = withErrorHandling(async () => {
  await requireBackoffice();
  return json(await listModelStock());
});
