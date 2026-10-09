/** Adresse postale d'une facture (donnée personnelle : affichée au seul utilisateur et au backoffice). */
export type PostalAddress = {
  id: string;
  fullName: string;
  company: string | null;
  line1: string;
  line2: string | null;
  postalCode: string;
  city: string;
  country: string;
  phone: string | null;
};

/** Adresse sur une ligne (« Alice Martin, 1 rue de la Paix, 69001 Lyon, FR »). */
export function addressOneLine(a: PostalAddress): string {
  return [a.fullName, a.company, a.line1, a.line2, `${a.postalCode} ${a.city}`, a.country].filter(Boolean).join(", ");
}

export function AddressBlock({ address }: { address: PostalAddress }) {
  return (
    <address className="shop-address">
      <strong>{address.fullName}</strong>
      {address.company && <span>{address.company}</span>}
      <span>{address.line1}</span>
      {address.line2 && <span>{address.line2}</span>}
      <span>
        {address.postalCode} {address.city}
      </span>
      <span>{address.country}</span>
      {address.phone && <span>{address.phone}</span>}
    </address>
  );
}
