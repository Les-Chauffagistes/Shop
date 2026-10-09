import { requireBackoffice } from "@/server/auth";
import { listAttentionOrders } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json } from "@/server/http";

/** Factures « à traiter ». */
export const GET = withErrorHandling(async () => {
  await requireBackoffice();
  return json(await listAttentionOrders());
});
