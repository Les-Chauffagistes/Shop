import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";
import { paymentInput, recordPayment, requirePaymentService } from "@/server/payments";

/**
 * Point d'entrée INTERNE du service de paiement (simulé au jalon 4) : paiement reçu sur l'adresse
 * d'une facture. Secret partagé (PAYMENT_WEBHOOK_SECRET) ; fermé (404) sans secret configuré.
 */
export const POST = withErrorHandling(async (request: Request) => {
  requirePaymentService(request);
  const result = await recordPayment(await readJson(request, paymentInput));
  return json(result, result.duplicate ? 200 : 201);
});
