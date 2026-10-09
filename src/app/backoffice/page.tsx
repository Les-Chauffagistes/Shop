import { redirect } from "next/navigation";
import { backofficeAccess } from "./_lib/access";

export default async function BackofficeHome() {
  await backofficeAccess("/backoffice");
  redirect("/backoffice/lots");
}
