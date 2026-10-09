import type { PartPressure } from "@/server/part-stock";
import { plural } from "@/lib/plural";

/**
 * Affichage de la pression sur le stock d'un produit d'option (docs/api.md, « Stock des produits
 * d'options »). Tout est calculé par le serveur : ce module ne fait que mettre en forme.
 * Un seul niveau d'avertissement : pression > 1 (`overPressure`), ou demande sans stock.
 */

/** "1.600" → "1,6" ; "0" → "0". Mise en forme seulement (aucun calcul). */
export function formatPressure(pressure: string): string {
  const [whole, fraction = ""] = pressure.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole},${trimmed}` : whole;
}

/** Produit en alerte : demande ferme au-delà du stock physique, ou demande sans aucun stock. */
export function isShort(stock: Pick<PartPressure, "pressure" | "overPressure" | "firmDemand">): boolean {
  return stock.overPressure || (stock.pressure === null && stock.firmDemand > 0);
}

/** Pastille de pression : « 1,6 » en alerte, « Sans stock » si la demande n'a aucun stock en face. */
export function PressureBadge({ stock }: { stock: PartPressure }) {
  if (stock.pressure === null) {
    return <span className="bo-badge bo-badge-cancelled">Demande sans stock</span>;
  }
  if (stock.overPressure) {
    return (
      <span className="bo-badge bo-badge-warning" title="Demande ferme supérieure au stock physique">
        {formatPressure(stock.pressure)} · manque {stock.shortfall}
      </span>
    );
  }
  if (stock.firmDemand === 0) return <span className="bo-muted">Aucune demande</span>;
  return <span className="bo-num">{formatPressure(stock.pressure)}</span>;
}

/** Phrase d'avertissement : ce qui manque et ce qu'il reste à commander une fois comptés les kits en route. */
export function shortfallSentence(stock: PartPressure): string {
  const incoming = stock.orderingQty + stock.awaitingDeliveryQty;
  const base =
    stock.onHand === 0
      ? `demande ferme de ${stock.firmDemand} sans aucun kit en stock`
      : `demande ferme de ${stock.firmDemand} pour ${plural(stock.onHand, "kit", "kits")} en stock (pression ${formatPressure(stock.pressure ?? "0")})`;
  const order =
    stock.toOrder > 0
      ? `${plural(stock.toOrder, "kit", "kits")} à commander`
      : "rien à commander de plus";
  return `${base}. Manque ${stock.shortfall}${incoming > 0 ? `, ${incoming} déjà commandé${incoming > 1 ? "s" : ""} ou en route` : ""} : ${order}.`;
}
