import Link from "next/link";
import type { BatchDetail } from "@/server/batches";
import { formatCents } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { plural } from "@/lib/plural";

type Stat = { label: string; value: number; small?: string; hint?: string };

function Stats({ stats }: { stats: Stat[] }) {
  return (
    <dl className="bo-stats">
      {stats.map((s) => (
        <div className="bo-stat" key={s.label} title={s.hint}>
          <dt>{s.label}</dt>
          <dd>
            {s.value} {s.small && <small>{s.small}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Factures à traiter, utilisateurs bloqués et journée de priorité du lot, s'il y a quelque chose à dire. */
function Attention({ batch }: { batch: BatchDetail }) {
  const c = batch.counters;
  if (c.attentionOrders === 0 && c.blockedUsers === 0 && !batch.priorityEndsAt) return null;
  return (
    <p className="bo-alert bo-alert-info" style={{ marginTop: 12 }}>
      {c.attentionOrders > 0 && (
        <>
          <a href="#factures" className="bo-cell-attention">
            {plural(c.attentionOrders, "facture à traiter", "factures à traiter")}
          </a>
          {" · "}
        </>
      )}
      {c.blockedUsers > 0 && (
        <>
          <Link href={`/backoffice/blocages?lot=${batch.id}`}>{plural(c.blockedUsers, "utilisateur bloqué", "utilisateurs bloqués")}</Link>
          {" · "}
        </>
      )}
      {batch.priorityEndsAt ? `Journée de priorité jusqu'au ${formatDateTime(batch.priorityEndsAt)}` : "Pas de journée de priorité"}
    </p>
  );
}

/**
 * Compteurs d'un lot (lus dans `counters`, calculés par la base). Palette : stock, payées, réservées, intéressés.
 * Lot de stock : disponibles, en rayon, à recevoir, à contrôler.
 */
export function BatchCounters({ batch }: { batch: BatchDetail }) {
  const c = batch.counters;
  const stats: Stat[] =
    batch.kind === "stock"
      ? [
          { label: "Disponibles", value: c.availableStock, hint: "Vendables, ni vendues ni réservées : ce que voit la boutique" },
          { label: "En rayon", value: c.sellableMachines, hint: "En main, contrôlées OK, d'aucune commande (réservées comprises)" },
          { label: "À recevoir", value: c.expectedMachines },
          { label: "À contrôler", value: c.toCheckMachines, hint: "Jamais contrôlées, ou à recontrôler depuis leur retour" },
          { label: "Payées", value: c.paidMachines, small: plural(c.pendingMachines, "réservée", "réservées") },
        ]
      : [
          { label: "Stock disponible", value: c.availableStock, small: `/ ${c.capacity}` },
          { label: "Machines payées", value: c.paidMachines, small: plural(c.paidOrders, "commande", "commandes") },
          { label: "Réservées (30 min)", value: c.pendingMachines, small: plural(c.pendingOrders, "facture", "factures") },
          { label: "Intéressés", value: c.interestedUsers, small: plural(c.interestedMachines, "machine", "machines") },
        ];
  return (
    <section aria-labelledby="counters">
      <h2 id="counters" className="bo-visually-hidden">
        Compteurs
      </h2>
      <Stats stats={stats} />
      <Attention batch={batch} />
      <p className="bo-hint" style={{ marginTop: 10 }} data-testid="quality-counters">
        Machines : <strong>{plural(c.okMachines, "OK", "OK")}</strong> · <strong>{plural(c.degradedMachines, "dégradée", "dégradées")}</strong>
        {c.machinesToStockDegraded > 0 && <> (dont {plural(c.machinesToStockDegraded, "invendue dégradée", "invendues dégradées")}, partiront au stock)</>}
        {" · "}commandes servies : {plural(c.okLines, "par une machine OK", "par une machine OK")}, {plural(c.degradedLines, "par une machine dégradée", "par une machine dégradée")}.
      </p>
      <p className="bo-hint" style={{ marginTop: 10 }}>
        {batch.kind === "wholesale" && (
          <>
            Prix d&apos;achat {formatCents(batch.purchasePrice)}
            {c.transferredOut > 0 && <> · {plural(c.transferredOut, "machine transférée", "machines transférées")} au stock</>} ·{" "}
          </>
        )}
        Revente {batch.resaleUnitPrice ? `${formatCents(batch.resaleUnitPrice)} l'unité` : "non définie"}
      </p>
    </section>
  );
}
