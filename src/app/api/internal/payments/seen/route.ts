import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";
import { paymentSeenInput, recordPaymentSeen, requirePaymentService } from "@/server/payments";

/**
 * Point d'entrée INTERNE du service de paiement : un paiement complet est vu avant ses confirmations,
 * le décompte de réservation s'arrête. Même secret que `POST /api/internal/payments`.
 */
export const POST = withErrorHandling(async (request: Request) => {
  requirePaymentService(request);
  return json(await recordPaymentSeen(await readJson(request, paymentSeenInput)));
});
