import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";
import { createManualSale, manualSaleInput } from "@/server/manual-sales";

/** Vente manuelle : facture née payée hors chaîne (espèces, virement, autre), au prix du lot. */
export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireBackoffice();
  return json(await createManualSale(await readJson(request, manualSaleInput), user), 201);
});
