import { AccessDenied } from "@/components/backoffice/AccessDenied";
import { getCurrentUser } from "@/server/auth";
import { loginUrl } from "./_lib/access";

/** Refus d'accès (HTTP 403) : connecté mais absent de la whitelist du backoffice. Voir backofficeAccess. */
export default async function BackofficeForbidden() {
  const user = await getCurrentUser();
  return <AccessDenied pseudo={user?.pseudo ?? null} switchAccountUrl={loginUrl("/backoffice")} />;
}
