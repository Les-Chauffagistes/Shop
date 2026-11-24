import { plural, pluralS } from "@/lib/plural";
import { Collapsible } from "../Collapsible";
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
}: Readonly<{
  /** `toCheck` : compteur du lot (`counters.toCheckMachines`), jamais contrôlées ou à recontrôler */
  batch: { id: string; kind: "wholesale" | "stock"; toCheck: number; model: { id: string; hashboardQtt: number } };
  data: BatchMachines;
}>) {
  const n = (key: string) => summaryCount(data.summary, key);
  const expected = n("expected");
  const toCheck = batch.toCheck;
  const toBuild = data.mountingPlan.reduce((sum, p) => sum + p.toBuild, 0);
  const stats: { label: string; value: number; hint?: string }[] = [
    { label: "Attendues", value: expected },
    { label: "À contrôler", value: toCheck, hint: n("toRecheck") > 0 ? `dont ${n("toRecheck")} à recontrôler` : undefined },
    { label: "OK", value: n("ok"), hint: n("okLines") > 0 ? `dont ${n("okLines")} attribuée${pluralS(n("okLines"))}` : undefined },
    {
      label: "Dégradées",
      value: n("degraded"),
      hint: [n("degradedLines") > 0 && `dont ${n("degradedLines")} attribuée${n("degradedLines") > 1 ? "s" : ""}`, n("unsoldDegraded") > 0 && `${n("unsoldDegraded")} invendue${n("unsoldDegraded") > 1 ? "s" : ""}`]
        .filter(Boolean)
        .join(", ") || undefined,
    },
    { label: "Défectueuses", value: n("faulty") },
    { label: "Expédiées", value: n("inTransit") + n("delivered"), hint: n("delivered") > 0 ? `dont ${n("delivered")} livrées` : undefined },
  ];
  // Ce qui demande une action, dans l'ordre du travail ; chaque point renvoie au bloc concerné
  const todo = [
    expected > 0 && { href: "#reception", text: `${plural(expected, "machine attendue", "machines attendues")} à recevoir` },
    toCheck > 0 && { href: "#machines", text: `${plural(toCheck, "machine", "machines")} à contrôler` },
    toBuild > 0 && { href: "#montage", text: `${plural(toBuild, "machine", "machines")} à monter` },
    n("unassignedLines") > 0 && { href: "#commandes", text: `${plural(n("unassignedLines"), "commande payée", "commandes payées")} sans machine` },
    n("linesToReplace") > 0 && { href: "#commandes", text: `${plural(n("linesToReplace"), "machine attribuée", "machines attribuées")} à remplacer ou à remonter` },
    n("surplusLines") > 0 && { href: "#commandes", text: `${plural(n("surplusLines"), "commande payée", "commandes payées")} en trop (pas assez de machines)` },
  ].filter((t): t is { href: string; text: string } => Boolean(t));

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
        <div className={`bo-alert ${todo.length > 0 ? "bo-alert-info" : "bo-alert-success"}`} style={{ marginTop: 12 }}>
          {todo.length > 0 ? (
            <>
              <strong>À faire</strong>
              <ul className="bo-todo">
                {todo.map((t) => (
                  <li key={t.text}>
                    <a href={t.href}>{t.text}</a>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            "Rien à faire sur les machines pour l'instant."
          )}{" "}
          <span className="bo-muted">
            {plural(n("assignedLines"), "commande servie", "commandes servies")} sur {n("paidLines")} payée{n("paidLines") > 1 ? "s" : ""}.
          </span>
        </div>
      </section>
      <div id="reception">
        <ReceptionPanel batch={batch} expected={expected} canReceiveExtra={data.canReceiveExtra} />
      </div>
      {data.mountingPlan.length > 0 && (
        <Collapsible id="montage" title="Plan de montage" hint={toBuild > 0 ? `${plural(toBuild, "machine", "machines")} à monter` : "rien à monter"} open={toBuild > 0}>
          <p className="bo-hint">Ce que les commandes payées exigent. Une machine n&apos;est attribuable que prête et montée exactement ainsi.</p>
          <ul data-testid="mounting-plan">
            {data.mountingPlan.map((p) => (
              <li key={p.key}>
                <strong>{p.items.map((i) => `${i.option} : ${i.value}`).join(" + ")}</strong> : {plural(p.lines, "commande à servir", "commandes à servir")},{" "}
                {p.inPreparation} en montage, {p.ready} prête{p.ready > 1 ? "s" : ""}
                {p.toBuild > 0 ? (
                  <> : <strong>{plural(p.toBuild, "machine à monter", "machines à monter")}</strong></>
                ) : (
                  " : rien à monter"
                )}
              </li>
            ))}
          </ul>
        </Collapsible>
      )}
      <div id="machines">
        <MachinesSection batch={batch} model={batch.model} machines={data.machines} mountingPlan={data.mountingPlan} />
      </div>
      <div id="commandes">
        <LinesSection batchId={batch.id} lines={data.lines} machines={data.machines} replacementAvailable={data.replacementAvailable} />
      </div>
    </div>
  );
}
