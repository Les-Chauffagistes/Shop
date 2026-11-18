import { requireBackoffice } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";
import { checkMachinesOk, checkOkInput } from "@/server/machines";

/** « Tout OK » : hashboards toutes OK et machine OK, en bloc (contrôle ou recontrôle). */
export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireBackoffice();
  return json(await checkMachinesOk(await readJson(request, checkOkInput), user), 201);
});
