"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

/**
 * Erreur imprévue d'une page de la boutique (base injoignable, panne du serveur) : message en
 * français et nouvelle tentative, sans détail technique. La référence permet de retrouver l'erreur
 * dans les journaux du serveur.
 */
export default function ShopError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [error]);

  return (
    <div className="bo-error-page">
      <p className="bo-code">PAGE INDISPONIBLE</p>
      <h1 ref={heading} tabIndex={-1}>
        Impossible d&apos;afficher cette page
      </h1>
      <p>La boutique ne répond pas pour le moment. Réessayez dans quelques instants.</p>
      <div className="bo-actions" style={{ justifyContent: "center" }}>
        <button type="button" className="bo-btn bo-btn-primary" onClick={() => retry()}>
          Réessayer
        </button>
        <Link className="bo-btn bo-btn-secondary" href="/">
          Accueil
        </Link>
      </div>
      {error.digest && (
        <p className="bo-hint" style={{ marginTop: 24 }}>
          Référence de l&apos;incident : {error.digest}
        </p>
      )}
    </div>
  );
}
