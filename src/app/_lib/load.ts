import { notFound } from "next/navigation";
import { z } from "zod";
import { ApiError } from "@/server/errors";

/** Identifiant bien formé : même définition que pathId (routes API) et les schémas Zod. */
export const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** Charge une ressource par identifiant de chemin ; identifiant mal formé ou inconnu → page 404. */
export async function loadOr404<T>(id: string, load: (id: string) => Promise<T>): Promise<T> {
  if (!isUuid(id)) notFound();
  try {
    return await load(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}
