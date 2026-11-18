import type { OrderDto } from "@/server/orders";
import { formatDateTime } from "@/lib/dates";

type Shipment = NonNullable<OrderDto["shipment"]>;

/** Seulement http/https : on ne fait jamais confiance à un `javascript:`, même si le serveur le garantit déjà. */
const safeUrl = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);

/** Résumé du suivi d'une commande dans la liste « Mes commandes » : statut, transporteur, numéro, lien. */
export function ShipmentSummary({ shipment }: Readonly<{ shipment: Shipment }>) {
  const url = safeUrl(shipment.trackingUrl);
  const status = statusText(shipment);
  const parts = [shipment.carrier, shipment.trackingNumber].filter(Boolean).join(" · ");
  return (
    <p className="bo-muted" data-testid="shipment-summary">
      {status}
      {parts && ` · ${parts}`}
      {url && (
        <>
          {" · "}
          <a href={url} target="_blank" rel="noopener noreferrer">
            Suivre le colis
          </a>
        </>
      )}
    </p>
  );
}

function statusText(shipment: Shipment): string {
  if (shipment.deliveredAt) return `Livrée le ${formatDateTime(shipment.deliveredAt)}`;
  if (shipment.shippedAt) return `Expédiée le ${formatDateTime(shipment.shippedAt)}`;
  return "Préparée, pas encore remise au transporteur";
}
