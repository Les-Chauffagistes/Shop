import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { getProfile } from "@/server/profile";
import { ProfileEmailForm } from "@/components/shop/ProfileEmailForm";
import { loginUrl, pagePath } from "../../_lib/login";

export const metadata: Metadata = { title: "Mon profil" };

/** Profil de l'utilisateur : son e-mail de contact, modifiable (jamais effaçable). */
export default async function ProfilePage({ searchParams }: PageProps<"/profil">) {
  const sp = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(loginUrl(pagePath("/profil", sp), "/profil"));
  const profile = await getProfile(user.id);

  return (
    <>
      <div className="shop-page-head">
        <h1>Mon profil</h1>
        <p>
          {user.pseudo ? <>Connecté en tant que {user.pseudo}. </> : null}
          Notre équipe se sert de votre adresse e-mail pour vous contacter au sujet de vos commandes.
        </p>
      </div>
      <section className="bo-card shop-narrow" aria-labelledby="email">
        <h2 id="email" style={{ marginBottom: 12 }}>
          E-mail de contact
        </h2>
        {profile.email === null && (
          <p className="bo-muted">Aucune adresse pour l&apos;instant : elle vous sera demandée à votre première commande.</p>
        )}
        <ProfileEmailForm current={profile.email} />
      </section>
    </>
  );
}
