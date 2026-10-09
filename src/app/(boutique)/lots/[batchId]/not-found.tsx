import Link from "next/link";

/** Lot inconnu, en brouillon ou qui n'est plus public : même réponse, sans rien révéler. */
export default function BatchNotFound() {
  return (
    <div className="bo-error-page">
      <p className="bo-code">LOT INDISPONIBLE</p>
      <h1>Ce lot n&apos;est pas disponible</h1>
      <p>Il n&apos;existe pas ou n&apos;est plus proposé dans la boutique. Les lots disponibles sont listés sur l&apos;accueil.</p>
      <div className="bo-actions" style={{ justifyContent: "center" }}>
        <Link className="bo-btn bo-btn-primary" href="/">
          Voir les lots disponibles
        </Link>
      </div>
    </div>
  );
}
