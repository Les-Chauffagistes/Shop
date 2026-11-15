import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";
import { changeMachineStatuses, statusChangesInput } from "@/server/machines";

/** Changements de statut d'une ou plusieurs machines (tout ou rien), remboursement des commandes en trop confirmé. */
export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireBackoffice();
  return json(await changeMachineStatuses(await readJson(request, statusChangesInput), user), 201);
});
