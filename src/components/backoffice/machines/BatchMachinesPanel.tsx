import { plural } from "@/lib/plural";
import { LinesSection } from "./LinesSection";
import { MachinesSection } from "./MachinesSection";
import { ReceptionPanel } from "./ReceptionPanel";
import { summaryCount, type BatchMachines } from "./types";

/**
 * Onglet « Machines » d'un lot (palette ou lot de stock) : résumé, réception, machines, commandes payées. Le
 * bandeau dit ce qui reste à faire, dans l'ordre du travail : recevoir, contrôler, attribuer, remplacer.
 */
export function BatchMachinesPanel({
  batch,
  data,
}: {
  /** `toCheck` : compteur du lot (`counters.toCheckMachines`), jamais contrôlées ou à recontrôler */
  batch: { id: string; kind: "wholesale" | "stock"; toCheck: number };
  data: BatchMachines;
}) {
  const n = (key: string) => summaryCount(data.summary, key);
  const expected = n("expected");
  const toCheck = batch.toCheck;
  const stats: { label: string; value: number; hint?: string }[] = [
    { label: "Attendues", value: expected },
    { label: "À contrôler", value: toCheck, hint: n("toRecheck") > 0 ? `dont ${n("toRecheck")} à recontrôler` : undefined },
    { label: "OK", value: n("ok") },
    { label: "Dégradées", value: n("degraded") },
    { label: "Défectueuses", value: n("faulty") },
    { label: "Expédiées", value: n("inTransit") + n("delivered"), hint: n("delivered") > 0 ? `dont ${n("delivered")} livrées` : undefined },
  ];
  const todo = [
    expected > 0 && `${plural(expected, "machine attendue", "machines attendues")} à recevoir`,
    toCheck > 0 && `${plural(toCheck, "machine", "machines")} à contrôler`,
    n("unassignedLines") > 0 && `${plural(n("unassignedLines"), "commande payée", "commandes payées")} sans machine`,
    n("linesToReplace") > 0 && `${plural(n("linesToReplace"), "machine attribuée", "machines attribuées")} à remplacer`,
    n("surplusLines") > 0 && `${plural(n("surplusLines"), "commande payée", "commandes payées")} en trop (pas assez de machines)`,
  ].filter((t): t is string => Boolean(t));

  return (
    <div className="bo-stack">
      <section aria-label="Résumé des machines">
        <dl className="bo-stats">
          {stats.map((s) => (
            <div className="bo-stat" key={s.label}>
              <dt>{s.label}</dt>
              <dd>
                {s.value} {s.hint && <small>{s.hint}</small>}
              </dd>
            </div>
          ))}
        </dl>
        <p className={`bo-alert ${todo.length > 0 ? "bo-alert-info" : "bo-alert-success"}`} style={{ marginTop: 12 }}>
          {todo.length > 0 ? <>À faire : {todo.join(" · ")}.</> : "Rien à faire sur les machines pour l'instant."}{" "}
          <span className="bo-muted">
            {plural(n("assignedLines"), "commande servie", "commandes servies")} sur {n("paidLines")} payée{n("paidLines") > 1 ? "s" : ""}.
          </span>
        </p>
      </section>
      <ReceptionPanel batch={batch} expected={expected} canReceiveExtra={data.canReceiveExtra} />
      <MachinesSection batch={batch} machines={data.machines} />
      <LinesSection batchId={batch.id} lines={data.lines} machines={data.machines} />
    </div>
  );
}
