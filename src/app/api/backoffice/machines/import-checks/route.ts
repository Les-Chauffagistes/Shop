import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";
import { importChecksInput, importMachineChecks } from "@/server/machines";

/** Import CSV du contrôle (`name,serial,board1_statut,…`) : analyse seule avec `dryRun`, sinon écriture tout ou rien. */
export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireBackoffice();
  const body = await readJson(request, importChecksInput);
  return json(await importMachineChecks(body, user), body.dryRun ? 200 : 201);
});
