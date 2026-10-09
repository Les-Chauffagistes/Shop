import { requireUser } from "@/server/auth";
import { withErrorHandling } from "@/server/errors";
import { json, readJson } from "@/server/http";
import { getProfile, profilePatch, updateProfile } from "@/server/profile";

/** Profil de l'utilisateur connecté (e-mail de contact). */
export const GET = withErrorHandling(async () => {
  const user = await requireUser();
  return json(await getProfile(user.id));
});

/** Change l'e-mail de contact du profil (il ne s'efface pas). */
export const PATCH = withErrorHandling(async (request: Request) => {
  const user = await requireUser();
  return json(await updateProfile(user.id, await readJson(request, profilePatch)));
});
