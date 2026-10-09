"use client";

import { useEffect, useRef } from "react";

/**
 * Erreur imprévue d'une page du backoffice (base de données injoignable, panne du serveur) :
 * message en français et nouvelle tentative, sans le détail technique de l'erreur. Le message
 * d'origine reste dans les journaux du serveur ; la référence permet de l'y retrouver.
 */
export default function BackofficeError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus(); // annonce le changement de page aux lecteurs d'écran
  }, [error]);

  return (
    <div className="bo-error-page">
      <p className="bo-code">PAGE INDISPONIBLE</p>
      <h1 ref={heading} tabIndex={-1}>
        Impossible d&apos;afficher cette page
      </h1>
      <p>
        Le serveur ou la base de données ne répond pas pour le moment. Vos dernières modifications enregistrées ne sont
        pas perdues. Réessayez dans quelques instants ; si le problème persiste, prévenez la personne qui gère
        l&apos;hébergement de la boutique.
      </p>
      <div className="bo-actions" style={{ justifyContent: "center" }}>
        <button type="button" className="bo-btn bo-btn-primary" onClick={() => retry()}>
          Réessayer
        </button>
      </div>
      {error.digest && (
        <p className="bo-hint" style={{ marginTop: 24 }}>
          Référence de l&apos;incident : {error.digest}
        </p>
      )}
    </div>
  );
}
