"use client";

import { useRef, useState } from "react";
import { expectedHeader, MAX_CSV_LENGTH } from "@/lib/machine-csv";
import { machines as machinesLabel, plural, pluralS } from "@/lib/plural";
import { MACHINE_FUNCTIONAL_LABELS } from "@/server/machine-status";
import { api, toFailure, type ApiFailure } from "../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { ErrorAlert, Field } from "../ui";
import type { MachineAction } from "./useMachineAction";
import type { Machine } from "./types";

type State = Machine["functionalStatus"];

/** Ligne de l'aperçu (`items` de la réponse, docs/api.md « Import CSV du contrôle »). */
type ImportItem = { line: number; serial: string; name: string; from: State; to: State; boardsChanged: number };

type ImportResult = { items: ImportItem[] };

/** Erreurs par ligne d'un `422 csv_invalid` (`line` null : en-tête ou fichier). */
type CsvIssues = { issues: { line: number | null; message: string }[]; count: number };

function csvIssuesOf(failure: ApiFailure | null): CsvIssues | null {
  if (failure?.code !== "csv_invalid") return null;
  const issues = Array.isArray(failure.details?.issues) ? (failure.details.issues as CsvIssues["issues"]) : [];
  const count = typeof failure.details?.issueCount === "number" ? failure.details.issueCount : issues.length;
  return { issues, count };
}

/** « 12 machines contrôlées, dont 2 passées dégradées. » */
function doneSentence(items: ImportItem[]): string {
  const degraded = items.filter((i) => i.to === "degraded" && i.from !== "degraded").length;
  return `Contrôle importé : ${machinesLabel(items.length)} contrôlée${pluralS(items.length)}${
    degraded > 0 ? `, dont ${degraded} passée${pluralS(degraded)} « Dégradée »` : ""
  }.`;
}

/**
 * Import CSV du contrôle des machines du modèle du lot : le fichier est analysé par l'API dès qu'il est choisi
 * (`dryRun`, rien n'est écrit), l'aperçu ou les erreurs par ligne s'affichent, puis « Importer » renvoie le même
 * fichier. Machines en moins : confirmation des remboursements par `useMachineAction` (`409 machine_shortage`).
 */
export function ImportChecksDialog({
  open,
  model,
  action,
  onClose,
}: Readonly<{ open: boolean; model: { id: string; hashboardQtt: number }; action: MachineAction; onClose: () => void }>) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [analysing, setAnalysing] = useState(false);
  const [preview, setPreview] = useState<ImportItem[] | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [tooBig, setTooBig] = useState(false);
  // Seule la dernière analyse compte (fichier changé pendant un appel)
  const request = useRef(0);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setCsv(null);
      setFileName("");
      setPreview(null);
      setFailure(null);
      setTooBig(false);
    }
  }

  const header = expectedHeader(model.hashboardQtt).join(",");
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(`${header}\n`)}`;

  async function choose(file: File | undefined) {
    const ticket = ++request.current;
    action.clearFailure();
    setPreview(null);
    setFailure(null);
    setTooBig(false);
    setCsv(null);
    setFileName(file?.name ?? "");
    if (!file) return;
    const text = await file.text();
    if (ticket !== request.current) return;
    if (text.length > MAX_CSV_LENGTH) {
      setTooBig(true);
      return;
    }
    setCsv(text);
    setAnalysing(true);
    try {
      const result = await api<ImportResult>("POST", "/api/backoffice/machines/import-checks", { modelId: model.id, csv: text, dryRun: true });
      if (ticket === request.current) setPreview(result.items);
    } catch (error) {
      if (ticket === request.current) setFailure(toFailure(error));
    } finally {
      if (ticket === request.current) setAnalysing(false);
    }
  }

  async function confirm() {
    if (csv === null || !preview) return;
    const outcome = await action.run(
      (confirmRefunds) =>
        api<ImportResult>("POST", "/api/backoffice/machines/import-checks", { modelId: model.id, csv, dryRun: false, confirmRefunds }),
      (result) => doneSentence(result.items),
    );
    if (outcome !== "failed") onClose();
  }

  // Refus à l'analyse, ou à l'import (machines changées entre-temps) : erreurs par ligne, import bloqué
  const shown = failure ?? action.failure;
  const csvIssues = csvIssuesOf(shown);
  const degraded = preview?.filter((i) => i.to === "degraded" && i.from !== "degraded").length ?? 0;

  return (
    <ConfirmDialog
      open={open}
      title="Importer un contrôle (CSV)"
      confirmLabel={preview ? `Importer ${machinesLabel(preview.length)}` : "Importer"}
      confirmDisabled={!preview || csvIssues !== null || analysing}
      pending={action.pending}
      onConfirm={confirm}
      onClose={() => {
        request.current++;
        action.clearFailure();
        onClose();
      }}
    >
      <p>
        Une ligne par machine, retrouvée par son numéro de série. Colonnes attendues pour ce modèle (
        {plural(model.hashboardQtt, "hashboard", "hashboards")}) :
      </p>
      <p>
        <code className="bo-mono">{header}</code>
      </p>
      <p className="bo-hint">
        Statuts : ok, degraded ou dead (ou « dégradée », « morte ») ; cellule vide = hashboard non contrôlée. Séparateur
        virgule ou point-virgule. La colonne name (numéro custom) est vérifiée si elle est remplie.{" "}
        <a href={template} download="controle-machines.csv">
          Télécharger un modèle vide
        </a>
      </p>
      <Field
        label="Fichier CSV"
        hint={fileName && analysing ? `Analyse de « ${fileName} »…` : undefined}
        error={tooBig ? "Fichier trop volumineux : découpez-le en plusieurs imports." : undefined}
      >
        {(p) => (
          <input
            {...p}
            type="file"
            accept=".csv,text/csv"
            className="bo-input"
            disabled={action.pending}
            onChange={(e) => void choose(e.target.files?.[0])}
          />
        )}
      </Field>

      {csvIssues ? (
        <div className="bo-alert bo-alert-error" role="alert" data-testid="import-issues">
          <strong>
            {shown?.message} {plural(csvIssues.count, "erreur", "erreurs")}
            {csvIssues.count > csvIssues.issues.length && ` (${csvIssues.issues.length} premières affichées)`} :
          </strong>
          <ul style={{ maxHeight: 240, overflowY: "auto" }}>
            {csvIssues.issues.map((i, k) => (
              <li key={`${i.line}-${k}`}>
                {i.line === null ? "En-tête" : `Ligne ${i.line}`} : {i.message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ErrorAlert failure={shown} />
      )}

      {preview && !csvIssues && (
        <>
          <p role="status">
            {plural(preview.length, "machine reconnue", "machines reconnues")}
            {degraded > 0 && `, dont ${degraded} passer${degraded > 1 ? "ont" : "a"} « Dégradée »`}. Rien n&apos;est encore
            enregistré.
          </p>
          <div className="bo-table-scroll" style={{ maxHeight: 300, overflowY: "auto" }}>
            <table className="bo-table" data-testid="import-preview">
              <thead>
                <tr>
                  <th scope="col">Ligne</th>
                  <th scope="col">N° custom</th>
                  <th scope="col">N° de série</th>
                  <th scope="col">État</th>
                  <th scope="col">Hashboards modifiées</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((i) => (
                  <tr key={i.line}>
                    <td className="bo-num">{i.line}</td>
                    <td>{i.name || <span className="bo-muted">—</span>}</td>
                    <td className="bo-mono">{i.serial}</td>
                    <td>
                      {i.from === i.to
                        ? MACHINE_FUNCTIONAL_LABELS[i.to]
                        : `${MACHINE_FUNCTIONAL_LABELS[i.from]} → ${MACHINE_FUNCTIONAL_LABELS[i.to]}`}
                    </td>
                    <td className="bo-num">{i.boardsChanged}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </ConfirmDialog>
  );
}
