import { requireBackoffice } from "@/server/auth";
import { blockReleaseInput, releaseOrderBlock } from "@/server/backoffice-orders";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";

/** « Lever le blocage » d'un utilisateur sur un lot. */
export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireBackoffice();
  return json(await releaseOrderBlock(await readJson(request, blockReleaseInput), user), 201);
});
