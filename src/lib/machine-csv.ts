/**
 * Import CSV du contrôle des machines : analyse pure (aucun accès base), importable par l'UI.
 *
 * Format : `name,serial,board1_statut,…,boardN_statut`. Le nombre de colonnes `boardN_statut` doit être celui du
 * modèle (`Model.hashboard_qtt`) : sinon le fichier entier est refusé. `name` n'a pas de sens métier arrêté
 * (peut-être le numéro custom) : il est lu et conservé, jamais utilisé pour trouver la machine (c'est `serial`).
 */

export type CsvBoardStatus = "ok" | "degraded" | "dead";

export type CsvRow = {
  /** Numéro de ligne du fichier (1 = en-tête) */
  line: number;
  name: string;
  serial: string;
  /** Un statut par hashboard, dans l'ordre ; `null` = cellule vide (hashboard non contrôlée, rien n'est écrit) */
  boards: (CsvBoardStatus | null)[];
};

export type CsvIssue = {
  /** Numéro de ligne du fichier ; absent pour une erreur d'en-tête ou de fichier */
  line?: number;
  message: string;
};

export type ParsedCsv = { rows: CsvRow[]; issues: CsvIssue[] };

const BOARD_STATUS_ALIASES: Record<string, CsvBoardStatus> = {
  ok: "ok",
  degraded: "degraded",
  degradee: "degraded",
  dead: "dead",
  morte: "dead",
};

/** Taille maximale d'un fichier d'import (caractères) : quelques milliers de machines. */
export const MAX_CSV_LENGTH = 1_000_000;

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase();

/** Découpe en lignes de cellules (guillemets RFC 4180, retours à la ligne `\n` ou `\r\n`). */
function splitCells(text: string, delimiter: string): string[][] {
  const lines: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      lines.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) lines.push([...row, cell]);
  return lines;
}

/** Séparateur : la virgule du format, ou le point-virgule des tableurs français quand l'en-tête n'a pas de virgule. */
function delimiterOf(text: string): string {
  const header = text.split(/\r?\n/, 1)[0];
  return !header.includes(",") && header.includes(";") ? ";" : ",";
}

/** Colonnes attendues pour un modèle à `boardQtt` hashboards. */
export const expectedHeader = (boardQtt: number) => [
  "name",
  "serial",
  ...Array.from({ length: boardQtt }, (_, i) => `board${i + 1}_statut`),
];

function headerIssues(header: string[], boardQtt: number): CsvIssue[] {
  const columns = header.map(normalize);
  const boardColumns = columns.filter((c) => /^board\d+_statut$/.test(c));
  const issues: CsvIssue[] = [];
  if (boardColumns.length !== boardQtt) {
    issues.push({
      line: 1,
      message: `Ce modèle a ${boardQtt} hashboard${boardQtt > 1 ? "s" : ""} : le fichier en déclare ${boardColumns.length} (colonnes ${expectedHeader(boardQtt).join(", ")} attendues).`,
    });
  } else if (columns.join() !== expectedHeader(boardQtt).join()) {
    issues.push({ line: 1, message: `En-tête inattendu : ${expectedHeader(boardQtt).join(", ")} attendu.` });
  }
  return issues;
}

/**
 * Analyse un fichier pour un modèle à `boardQtt` hashboards. Tout problème d'en-tête (nombre de hashboards compris)
 * annule l'analyse des lignes : le fichier est refusé en entier. Les problèmes de ligne sont tous rapportés.
 */
export function parseMachineCsv(input: string, boardQtt: number): ParsedCsv {
  const text = input.replace(/^﻿/, "");
  const lines = splitCells(text, delimiterOf(text)).filter((cells) => cells.some((c) => c.trim() !== ""));
  if (lines.length === 0) return { rows: [], issues: [{ message: "Le fichier est vide." }] };
  const header = headerIssues(lines[0], boardQtt);
  if (header.length > 0) return { rows: [], issues: header };

  const rows: CsvRow[] = [];
  const issues: CsvIssue[] = [];
  const seen = new Map<string, number>();
  lines.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (cells.length !== boardQtt + 2) {
      issues.push({ line, message: `${boardQtt + 2} colonnes attendues, ${cells.length} trouvées.` });
      return;
    }
    const [name, serialCell, ...rest] = cells.map((c) => c.trim());
    const boards = rest.map((cell, b) => {
      if (cell === "") return null;
      const status = BOARD_STATUS_ALIASES[normalize(cell)];
      if (!status) issues.push({ line, message: `Hashboard ${b + 1} : statut « ${cell} » inconnu (ok, degraded ou dead).` });
      return status ?? null;
    });
    if (serialCell === "") issues.push({ line, message: "Numéro de série vide." });
    else if (seen.has(serialCell)) issues.push({ line, message: `Numéro de série « ${serialCell} » déjà listé ligne ${seen.get(serialCell)}.` });
    else seen.set(serialCell, line);
    rows.push({ line, name, serial: serialCell, boards });
  });
  if (rows.length === 0) issues.push({ message: "Le fichier ne contient aucune machine." });
  return { rows, issues };
}
