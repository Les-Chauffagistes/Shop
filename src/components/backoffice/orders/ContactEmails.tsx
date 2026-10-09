/**
 * Lien `mailto:` sûr : la base n'impose qu'un format souple (la partie locale peut contenir `?`, `&`, `=`,
 * `%`), qui ajouterait sinon un destinataire en copie, un objet ou un corps au message de l'admin.
 * Tout est encodé sauf l'arobase.
 */
export function mailtoHref(email: string): string {
  return `mailto:${encodeURIComponent(email).replace("%40", "@")}`;
}

/**
 * E-mails d'un client au backoffice, en liens `mailto:` : celui donné pour la facture (`contactEmail`,
 * instantané) et celui du profil (`profileEmail`, actuel), ce dernier seulement s'il diffère. Sans
 * crochet : utilisable dans une page serveur comme dans une cellule de grille.
 */
export function ContactEmails({
  contactEmail,
  profileEmail,
  compact = false,
}: {
  contactEmail: string | null;
  profileEmail: string | null;
  /** Cellule de grille : texte réduit, sans libellé pour l'e-mail principal */
  compact?: boolean;
}) {
  const main = contactEmail ?? profileEmail;
  const other = contactEmail !== null && profileEmail !== null && profileEmail !== contactEmail ? profileEmail : null;
  if (main === null) {
    return <span className="bo-muted">{compact ? "Pas d'e-mail" : "Aucun e-mail connu : ni sur la facture, ni sur le profil."}</span>;
  }
  const mainLabel = contactEmail !== null ? "Facture" : "Profil";
  return (
    <span className={compact ? "bo-emails bo-emails-compact" : "bo-emails"}>
      <span>
        {!compact && <span className="bo-muted">{mainLabel} : </span>}
        <a href={mailtoHref(main)}>{main}</a>
      </span>
      {other && (
        <span>
          <span className="bo-muted">Profil{compact ? "" : " (actuel)"} : </span>
          <a href={mailtoHref(other)}>{other}</a>
        </span>
      )}
    </span>
  );
}
