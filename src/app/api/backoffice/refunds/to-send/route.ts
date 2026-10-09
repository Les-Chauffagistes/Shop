import { requireBackoffice } from "@/server/auth";
import { listRefundsToSend } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json } from "@/server/http";

/** Remboursements créés mais pas encore envoyés, les plus anciens d'abord, avec l'adresse effective. */
export const GET = withErrorHandling(async () => {
  await requireBackoffice();
  return json(await listRefundsToSend());
});
