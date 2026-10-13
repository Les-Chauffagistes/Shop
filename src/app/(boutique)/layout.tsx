import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { ShopNav } from "@/components/shop/ShopNav";
import { getCurrentUser, type CurrentUser } from "@/server/auth";
import { loginTarget } from "../_lib/login";
import "../backoffice/backoffice.css";
import "./boutique.css";

// Rendu à chaque requête : la configuration (src/server/config.ts) n'existe qu'à l'exécution, le
// build n'a aucune variable d'environnement.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { template: "%s · Les Chauffagistes", default: "Les Chauffagistes · Boutique de mineurs" },
  description: "La boutique de machines de minage des Chauffagistes : achat groupé de lots, revente à l'unité.",
};

/**
 * Coquille de la boutique publique. Reprend les jetons, boutons, champs et messages du backoffice
 * (`.bo`), avec une mise en page plus aérée (`.shop`). L'utilisateur n'est lu que pour l'en-tête :
 * chaque page refait sa propre lecture (un layout ne se ré-exécute pas à la navigation).
 */
export default async function ShopLayout({ children }: LayoutProps<"/">) {
  let user: CurrentUser | null = null;
  try {
    user = await getCurrentUser();
  } catch (error) {
    unstable_rethrow(error);
    // Base injoignable : en-tête sans compte ; la page échouera à son tour et sera rattrapée par error.tsx
  }
  return (
    <div className="bo shop">
      <a className="bo-skip" href="#contenu">
        Aller au contenu
      </a>
      <header className="bo-header">
        <div className="bo-header-inner">
          <Link href="/" className="bo-brand">
            <span className="bo-brand-dot" aria-hidden="true" />
            Les Chauffagistes
          </Link>
          <ShopNav
            signedIn={user !== null}
            pseudo={user?.pseudo ?? null}
            isBackoffice={user?.isBackoffice ?? false}
            login={loginTarget()}
          />
        </div>
      </header>
      <main className="shop-main" id="contenu">
        {children}
      </main>
    </div>
  );
}
