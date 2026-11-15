import { HASHBOARD_LABELS } from "@/server/machine-status";
import { FUNCTIONAL_TONE, type Machine } from "./types";

/** État fonctionnel d'une machine (libellé de l'API), avec « à recontrôler » après un retour en main. */
export function FunctionalBadge({ machine }: { machine: Pick<Machine, "functionalStatus" | "functionalLabel" | "toRecheck"> }) {
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <span className={`bo-badge bo-badge-${FUNCTIONAL_TONE[machine.functionalStatus]}`}>{machine.functionalLabel}</span>
      {machine.toRecheck && <span className="bo-badge bo-badge-warning">À recontrôler</span>}
    </span>
  );
}

/** Hashboards en une ligne (« OK · OK · Morte ») ; « — » si aucune n'est saisie. */
export function hashboardsText(hashboards: Machine["hashboards"]): string {
  if (hashboards.every((h) => h.status === null)) return "—";
  return hashboards.map((h) => (h.status ? HASHBOARD_LABELS[h.status] : "?")).join(" · ");
}
