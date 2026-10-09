import Link from "next/link";

/** Refus d'accès : utilisateur connecté mais absent de la whitelist du backoffice. */
export function AccessDenied({ pseudo, switchAccountUrl }: { pseudo: string | null; switchAccountUrl: string }) {
  return (
    <main className="bo-denied" id="contenu">
      <p className="bo-code">ERREUR 403</p>
      <h1>Accès réservé</h1>
      <p>
        {pseudo ? <>Le compte « {pseudo} » n&apos;a</> : <>Votre compte n&apos;a</>} pas accès au backoffice de la
        boutique. Si vous pensez qu&apos;il s&apos;agit d&apos;une erreur, contactez un administrateur.
      </p>
      <div className="bo-actions" style={{ justifyContent: "center" }}>
        <Link className="bo-btn bo-btn-secondary" href="/">
          Retour à la boutique
        </Link>
        <a className="bo-btn bo-btn-ghost" href={switchAccountUrl}>
          Changer de compte
        </a>
      </div>
    </main>
  );
}
