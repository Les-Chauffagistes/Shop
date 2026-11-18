import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { HASHBOARD_LABELS, MACHINE_FUNCTIONAL_LABELS, MACHINE_LOGISTICAL_LABELS } from "@/server/machine-status";
import { getMachine } from "@/server/machines";
import { TRANSFER_REASONS } from "@/components/backoffice/batches/TransferHistory";
import { FunctionalBadge } from "@/components/backoffice/machines/MachineBadges";
import { MachineActions } from "@/components/backoffice/machines/MachineActions";
import { MachineEditForm } from "@/components/backoffice/machines/MachineEditForm";
import { machineName, type MachineDetail } from "@/components/backoffice/machines/types";
import { mailtoHref } from "@/components/backoffice/orders/ContactEmails";
import { StatusBadge } from "@/components/backoffice/StatusBadge";
import { ShipmentInfo } from "@/components/shop/ShipmentInfo";
import { formatDateTime } from "@/lib/dates";
import { backofficeAccess } from "../../_lib/access";
import { loadOr404 } from "@/app/_lib/load";

export const metadata: Metadata = { title: "Machine" };

const date = (iso: string | null) => (iso ? formatDateTime(iso) : "—");

function Facts({ items }: Readonly<{ items: [string, ReactNode][] }>) {
  return (
    <dl className="bo-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Journal des statuts, du plus récent au plus ancien : statut logistique et état fonctionnel avant → après. */
function StatusLog({ machine }: Readonly<{ machine: MachineDetail }>) {
  return (
    <ol className="bo-history" reversed>
      {[...machine.statusChanges].reverse().map((c) => (
        <li key={c.id}>
          <span>
            {c.fromLogistical !== c.toLogistical && (
              <>
                {MACHINE_LOGISTICAL_LABELS[c.fromLogistical]} → <strong>{MACHINE_LOGISTICAL_LABELS[c.toLogistical]}</strong>
              </>
            )}
            {c.fromLogistical !== c.toLogistical && c.fromFunctional !== c.toFunctional && " · "}
            {c.fromFunctional !== c.toFunctional && (
              <>
                {MACHINE_FUNCTIONAL_LABELS[c.fromFunctional]} → <strong>{MACHINE_FUNCTIONAL_LABELS[c.toFunctional]}</strong>
              </>
            )}
          </span>
          {c.note && <q>{c.note}</q>}
          <span className="bo-by">
            <time dateTime={c.createdAt}>{formatDateTime(c.createdAt)}</time> · admin n° {c.changedBy}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Attributions des lignes où la machine est passée, puis transferts : du plus récent au plus ancien. */
function MovesLog({ machine }: Readonly<{ machine: MachineDetail }>) {
  const moves = [
    ...machine.assignments.map((a) => ({
      id: a.id,
      createdAt: a.createdAt,
      changedBy: a.changedBy,
      note: a.reason,
      text: (
        <>
          {assignmentVerb(a.machineId, machine.id)}
          <Link href={`/backoffice/factures/${a.orderId}`}>machine {a.position} d&apos;une facture</Link>
        </>
      ),
    })),
    ...machine.transfers.map((t) => ({
      id: t.id,
      createdAt: t.createdAt,
      changedBy: t.changedBy,
      note: t.note,
      text: (
        <>
          {TRANSFER_REASONS[t.reason]} : <Link href={`/backoffice/lots/${t.from.id}`}>{t.from.name}</Link> →{" "}
          <Link href={`/backoffice/lots/${t.to.id}`}>{t.to.name}</Link>
        </>
      ),
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (moves.length === 0) return <p className="bo-muted">Aucune attribution ni aucun transfert.</p>;
  return (
    <ol className="bo-history">
      {moves.map((m) => (
        <li key={m.id}>
          <span>{m.text}</span>
          {m.note && <q>{m.note}</q>}
          <span className="bo-by">
            <time dateTime={m.createdAt}>{formatDateTime(m.createdAt)}</time> · {m.changedBy === null ? "Automatique" : `admin n° ${m.changedBy}`}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Fiche d'une machine : où elle est, d'où elle vient, à qui elle est attribuée, son contrôle et ses journaux. */
export default async function MachinePage({ params }: PageProps<"/backoffice/machines/[machineId]">) {
  const { machineId } = await params;
  await backofficeAccess(`/backoffice/machines/${encodeURIComponent(machineId)}`);
  const machine = await loadOr404(machineId, (id) => getMachine(id));

  return (
    <>
      <div className="bo-page-head">
        <div>
          <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
            <Link href="/backoffice/machines">Machines</Link> ›{" "}
            <Link href={`/backoffice/lots/${machine.batch.id}?onglet=machines`}>{machine.batch.name}</Link>
          </nav>
          <h1 style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span className="bo-mono">{machineName(machine)}</span>
            <span className="bo-badge bo-badge-logistics">{machine.logisticalLabel}</span>
            <FunctionalBadge machine={machine} />
          </h1>
          <p>
            {machine.model.name}
            {machine.batch.kind === "stock" && <> · {machine.sellable ? "vendable depuis le stock" : "pas vendable depuis le stock"}</>}
          </p>
        </div>
      </div>

      <div className="bo-grid-2">
        <div className="bo-stack">
          <section className="bo-card" aria-labelledby="ou">
            <h2 id="ou" style={{ marginBottom: 16 }}>
              Situation
            </h2>
            <Facts
              items={[
                [
                  "Lot actuel",
                  <>
                    <Link href={`/backoffice/lots/${machine.batch.id}`}>{machine.batch.name}</Link>{" "}
                    <StatusBadge status={machine.batch.status} label={machine.batch.statusLabel} />
                  </>,
                ],
                [
                  "Origine",
                  machine.originBatch ? (
                    <>
                      Palette <Link href={`/backoffice/lots/${machine.originBatch.id}`}>{machine.originBatch.name}</Link>
                    </>
                  ) : (
                    "Réassort du lot de stock"
                  ),
                ],
                [
                  "Commande",
                  machine.line ? (
                    <>
                      <Link href={`/backoffice/factures/${machine.line.orderId}`}>Machine {machine.line.position} de la facture</Link>
                      {machine.line.customer.contactEmail && (
                        <>
                          {" · "}
                          <a href={mailtoHref(machine.line.customer.contactEmail)}>{machine.line.customer.contactEmail}</a>
                        </>
                      )}
                    </>
                  ) : (
                    <span className="bo-muted">Aucune</span>
                  ),
                ],
                ["Reçue le", date(machine.receivedAt)],
                ["En main depuis", date(machine.inHandSince)],
                ["Expédiée le", date(machine.shippedAt)],
                ["Livrée le", date(machine.deliveredAt)],
              ]}
            />
            {machine.note && <p className="bo-alert bo-alert-info" style={{ marginTop: 12 }}>{machine.note}</p>}
          </section>

          <section className="bo-card" aria-labelledby="envoi">
            <h2 id="envoi" style={{ marginBottom: 16 }}>
              Envoi de la facture
            </h2>
            <ShipmentInfo shipment={machine.shipment} shared />
          </section>

          <section className="bo-card" aria-labelledby="hashboards">
            <h2 id="hashboards" style={{ marginBottom: 16 }}>
              Hashboards
            </h2>
            <div className="bo-table-scroll">
              <table className="bo-table">
                <thead>
                  <tr>
                    <th scope="col">Hashboard</th>
                    <th scope="col">État</th>
                    <th scope="col">Saisie</th>
                  </tr>
                </thead>
                <tbody>
                  {machine.hashboards.map((h) => (
                    <tr key={h.index}>
                      <td>Hashboard {h.index + 1}</td>
                      <td>
                        {h.status ? HASHBOARD_LABELS[h.status] : <span className="bo-muted">Non contrôlée</span>}
                        {h.status && !h.current && <span className="bo-badge bo-badge-warning" style={{ marginLeft: 8 }}>À ressaisir</span>}
                      </td>
                      <td className="bo-muted">{h.updatedAt ? `${formatDateTime(h.updatedAt)} · admin n° ${h.checkedBy}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="bo-card" aria-labelledby="saisie">
            <h2 id="saisie" style={{ marginBottom: 16 }}>
              Numéros et suivi
            </h2>
            <MachineEditForm machine={machine} />
          </section>

          <section className="bo-card" aria-labelledby="journal">
            <h2 id="journal" style={{ marginBottom: 16 }}>
              Journal des statuts
            </h2>
            {machine.statusChanges.length === 0 ? <p className="bo-muted">Aucun changement : machine attendue.</p> : <StatusLog machine={machine} />}
          </section>

          <section className="bo-card" aria-labelledby="mouvements">
            <h2 id="mouvements" style={{ marginBottom: 16 }}>
              Attributions et transferts
            </h2>
            <MovesLog machine={machine} />
          </section>
        </div>
        <aside style={{ position: "sticky", top: 72 }} aria-label="Actions de la machine">
          <MachineActions machine={machine} />
        </aside>
      </div>
    </>
  );
}

function assignmentVerb(assignedId: string | null, currentId: string): string {
  if (assignedId === currentId) return "Attribuée à la ";
  return assignedId ? "Remplacée sur la " : "Retirée de la ";
}
