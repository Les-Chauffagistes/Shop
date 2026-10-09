import { formatCents } from "@/lib/decimal";

/**
 * Avertissement quand le prix actuel du lot (machine seule, `resaleUnitPrice` de l'API) diffère de
 * l'instantané de la manifestation d'intérêt (`basePrice`). L'instantané reste le prix de la
 * wishlist ; l'API ne renvoie le prix actuel que tant que la configuration est modifiable (sinon
 * `null` : rien à afficher). Une nouvelle configuration est un nouvel instantané, au prix du jour.
 */
export function PriceChangeNotice({ basePrice, resaleUnitPrice }: { basePrice: string; resaleUnitPrice: string | null }) {
  if (resaleUnitPrice === null || BigInt(resaleUnitPrice) === BigInt(basePrice)) return null;
  return (
    <div className="bo-alert bo-alert-warning shop-price-change" role="note">
      Le prix a changé depuis votre manifestation d&apos;intérêt : {formatCents(resaleUnitPrice)} aujourd&apos;hui,{" "}
      {formatCents(basePrice)} lors de votre choix (machine seule).
      {" "}Si vous enregistrez à nouveau votre configuration, le prix d&apos;aujourd&apos;hui s&apos;appliquera.
    </div>
  );
}

/**
 * Avertissement quand un choix de la manifestation d'intérêt n'est plus proposé par le lot (option
 * retirée depuis) : le prix affiché n'est plus d'actualité et la commande de cette machine telle
 * quelle serait refusée par le serveur. Tant que la configuration est modifiable, on invite à la
 * revoir ; figée (précommande), on dit comment s'en sortir.
 */
export function OutdatedChoiceNotice({
  items,
  editable,
}: {
  items: readonly { optionTitle: string; label: string; offered: boolean }[];
  editable: boolean;
}) {
  const gone = items.filter((i) => !i.offered).map((i) => `« ${i.optionTitle} : ${i.label} »`);
  if (gone.length === 0) return null;
  return (
    <div className="bo-alert bo-alert-warning shop-price-change" role="note">
      {gone.length === 1 ? `L'option ${gone[0]} n'est plus proposée` : `Les options ${gone.join(", ")} ne sont plus proposées`} sur
      ce lot : le prix affiché n&apos;est plus d&apos;actualité.{" "}
      {editable
        ? "Modifiez votre configuration pour la mettre à jour."
        : "La configuration est figée : cette machine ne pourra pas être commandée telle quelle. Retirez-la et choisissez une autre configuration, ou contactez-nous."}
    </div>
  );
}
