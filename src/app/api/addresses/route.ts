import { requireUser } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json } from "@/server/http";
import { listAddresses } from "@/server/orders";

/** Adresses enregistrées de l'utilisateur (préremplissage de la facturation et de la livraison). */
export const GET = withErrorHandling(async () => {
  const user = await requireUser();
  return json(await listAddresses(user.id));
});
