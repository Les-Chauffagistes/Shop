"use client";

import { useState } from "react";
import { ErrorAlert, Notice } from "../ui";
import { ControlDialog } from "./ControlDialog";
import { changeDone, needsDialog, sendStatusChange, StatusChangeDialog, type StatusChange } from "./StatusChangeDialog";
import { useMachineAction } from "./useMachineAction";
import type { Machine } from "./types";

/**
 * Actions de la fiche d'une machine : contrôle (état et hashboards) et changements de statut proposés par l'API
 * (`nextChanges`, avec leurs blocages connus). Un changement sans saisie part en un clic.
 */
export function MachineActions({ machine }: { machine: Machine }) {
  const action = useMachineAction();
  const [change, setChange] = useState<StatusChange | null>(null);
  const [control, setControl] = useState<Machine | null>(null);

  function start(c: StatusChange) {
    if (needsDialog(c)) setChange(c);
    else void action.run(sendStatusChange(c, null, null), changeDone(c));
  }

  return (
    <div className="bo-next" role="group" aria-labelledby="machine-actions">
      <p className="bo-next-label" id="machine-actions">
        Actions
      </p>
      <Notice message={action.notice} />
      {!change && !control && <ErrorAlert failure={action.failure} />}
      {machine.inHand && (
        <div className="bo-transition">
          <button type="button" className="bo-btn bo-btn-primary" onClick={() => setControl(machine)} disabled={action.pending}>
            {machine.functionalStatus === "unknown" || machine.toRecheck ? "Contrôler" : "Corriger le contrôle"}
          </button>
        </div>
      )}
      {machine.nextChanges.map((c) => (
        <div key={c.to} className="bo-transition">
          <button
            type="button"
            className="bo-btn bo-btn-secondary"
            disabled={!c.allowed || action.pending}
            aria-describedby={c.blockers.length > 0 ? `blockers-${c.to}` : undefined}
            onClick={() => start({ machines: [machine], to: c.to, action: c.action, toLabel: c.toLabel, noteRequired: c.noteRequired })}
          >
            {c.action}
          </button>
          {c.blockers.length > 0 && (
            <ul className="bo-blockers" id={`blockers-${c.to}`}>
              {c.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {!machine.inHand && machine.nextChanges.length === 0 && <p className="bo-muted">Aucune action : la machine est {machine.logisticalLabel.toLowerCase()}.</p>}
      <StatusChangeDialog change={change} action={action} onClose={() => setChange(null)} />
      <ControlDialog machine={control} action={action} onClose={() => setControl(null)} />
      {action.dialog}
    </div>
  );
}
