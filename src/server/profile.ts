import { z } from "zod";
import { getDb } from "./db";

/**
 * Profil de l'utilisateur connecté : son e-mail de contact (`User.email`, v5j). L'e-mail vit dans ce
 * projet (auth-service n'en a pas) ; il préremplit la facture suivante et l'admin s'en sert pour
 * contacter la personne. Format imposé par la base (`User_email_check` → `422 invalid_contact_email`,
 * même règle que l'instantané de la facture). Donnée personnelle : jamais dans les journaux.
 */

/** Longueur maximale d'une adresse e-mail (RFC 5321), comme en base. */
const EMAIL_MAX = 254;

/**
 * E-mail saisi : espaces de bord retirés, casse conservée. Le format est vérifié par la base
 * (`User_email_check`, `Order_contact_email_check`), source unique de la règle.
 */
const emailText = z.string({ error: "Adresse e-mail attendue" }).trim().max(EMAIL_MAX, { error: `${EMAIL_MAX} caractères au plus` });

/** E-mail de profil : on peut le changer, pas l'effacer (il sert à commander). */
export const profilePatch = z.strictObject({
  email: emailText.min(1, { error: "Adresse e-mail obligatoire : vous pouvez la changer, pas l'effacer" }),
});

/** E-mail de contact d'une facture, facultatif (`""` ou `null` = absent : celui du profil s'applique). */
export const optionalContactEmail = emailText
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));

function profileDto(user: { email: string | null }) {
  return { email: user.email };
}

export async function getProfile(userId: string) {
  return profileDto(await getDb().user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }));
}

export async function updateProfile(userId: string, input: z.output<typeof profilePatch>) {
  return profileDto(await getDb().user.update({ where: { id: userId }, data: { email: input.email }, select: { email: true } }));
}
