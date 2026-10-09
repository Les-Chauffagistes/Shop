import Link from "next/link";

/** Ressource introuvable dans la boutique (manifestation d'intérêt d'un autre, retirée ou inconnue…). */
export default function ShopNotFound() {
  return (
    <div className="bo-error-page">
      <p className="bo-code">PAGE INTROUVABLE</p>
      <h1>Cette page n&apos;existe pas</h1>
      <p>Elle a peut-être été retirée, ou le lien est incomplet.</p>
      <div className="bo-actions" style={{ justifyContent: "center" }}>
        <Link className="bo-btn bo-btn-primary" href="/">
          Voir les lots disponibles
        </Link>
        <Link className="bo-btn bo-btn-secondary" href="/mes-commandes">
          Mes commandes
        </Link>
      </div>
    </div>
  );
}
