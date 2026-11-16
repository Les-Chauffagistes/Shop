import type { OrderDto } from "@/server/orders";
import { formatDateTime } from "@/lib/dates";

type Shipment = NonNullable<OrderDto["shipment"]>;

/** Lien de suivi : seulement http/https (le serveur le garantit déjà, on ne fait jamais confiance à un `javascript:`). */
const safeUrl = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);

/**
 * Envoi d'une facture (transporteur, numéro, lien de suivi, dates), commun au client, à la facture admin et à la
 * fiche machine. Le suivi est unique par facture. `null` : rien n'est parti.
 */
export function ShipmentInfo({ shipment, shared }: { shipment: Shipment | null; shared?: boolean }) {
  if (!shipment) return <p className="bo-muted">Pas encore expédiée.</p>;
  const url = safeUrl(shipment.trackingUrl);
  const hasTracking = shipment.carrier || shipment.trackingNumber || url;
  return (
    <>
      <dl className="bo-facts" data-testid="shipment">
        <div>
          <dt>Transporteur</dt>
          <dd>{shipment.carrier ?? "—"}</dd>
        </div>
        <div>
          <dt>Numéro de suivi</dt>
          <dd className="bo-mono">{shipment.trackingNumber ?? "—"}</dd>
        </div>
        <div>
          <dt>Lien de suivi</dt>
          <dd>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                Suivre le colis
              </a>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>Expédiée le</dt>
          <dd>{shipment.shippedAt ? formatDateTime(shipment.shippedAt) : "Pas encore remise au transporteur"}</dd>
        </div>
        <div>
          <dt>Livrée le</dt>
          <dd>{shipment.deliveredAt ? formatDateTime(shipment.deliveredAt) : "—"}</dd>
        </div>
      </dl>
      {!hasTracking && <p className="bo-hint">Le suivi du colis n&apos;est pas encore renseigné.</p>}
      {shared && <p className="bo-hint">Le suivi est commun à toutes les machines de la facture.</p>}
    </>
  );
}
