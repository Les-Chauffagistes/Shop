import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { BackofficeNav } from "@/components/backoffice/BackofficeNav";
import { getCurrentUser, type CurrentUser } from "@/server/auth";
import "./backoffice.css";
// Blocs de facture partagés avec la boutique (machines, remboursements, adresses : classes shop-*)
import "../(boutique)/boutique.css";

// Rendu à chaque requête : la configuration (src/server/config.ts) n'existe qu'à l'exécution, le
// build n'a aucune variable d'environnement.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { template: "%s · Backoffice", default: "Backoffice" },
  robots: { index: false, follow: false },
};

/**
 * Coquille du backoffice. La navigation n'est rendue que pour un utilisateur de la whitelist ;
 * chaque page refait sa propre garde (backofficeAccess), car un layout ne se ré-exécute pas
 * à la navigation et ne protège pas à lui seul les segments enfants.
 */
export default async function BackofficeLayout({ children }: LayoutProps<"/backoffice">) {
  let user: CurrentUser | null;
  try {
    user = await getCurrentUser();
  } catch (error) {
    unstable_rethrow(error);
    // Utilisateur illisible (base injoignable…) : coquille sans navigation. La page, qui refait sa
    // garde, échouera à son tour et sera rattrapée par error.tsx, rendu dans cette coquille stylée
    // (une erreur levée ici même échapperait à error.tsx et donnerait la page d'erreur brute).
    return (
      <div className="bo">
        <main className="bo-main" id="contenu">
          {children}
        </main>
      </div>
    );
  }
  if (!user?.isBackoffice) return <div className="bo">{children}</div>;
  return (
    <div className="bo">
      <a className="bo-skip" href="#contenu">
        Aller au contenu
      </a>
      <header className="bo-header">
        <div className="bo-header-inner">
          <Link href="/backoffice/lots" className="bo-brand">
            <span className="bo-brand-dot" aria-hidden="true" />
            Les Chauffagistes <small>Backoffice</small>
          </Link>
          <BackofficeNav />
          {user.pseudo && <span className="bo-user">{user.pseudo}</span>}
        </div>
      </header>
      <main className="bo-main" id="contenu">
        {children}
      </main>
    </div>
  );
}
