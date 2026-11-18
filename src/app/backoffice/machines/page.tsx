import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { listMachines } from "@/server/machines";
import { MachineListGrid } from "@/components/backoffice/machines/MachineListGrid";
import { backofficeAccess } from "../_lib/access";

export const metadata: Metadata = { title: "Machines" };

const PAGE_SIZE = 100;

/**
 * Recherche d'une machine par numéro de série (machine ou alimentation, sous-chaîne, sans casse), tous lots
 * confondus. Un numéro exact ou un seul résultat ouvre directement sa fiche (lecteur de codes-barres : scanner, Entrée).
 */
export default async function MachinesPage({ searchParams }: PageProps<"/backoffice/machines">) {
  const raw = (await searchParams).q;
  const q = (typeof raw === "string" ? raw : "").trim().slice(0, 100);
  await backofficeAccess(q ? `/backoffice/machines?q=${encodeURIComponent(q)}` : "/backoffice/machines");
  const result = q ? await listMachines({ q, logistical: [], functional: [], page: 1, pageSize: PAGE_SIZE }) : null;
  // Numéro exact (lecteur de codes-barres) : la fiche, même si d'autres numéros le contiennent
  if (result?.exactMatchId) redirect(`/backoffice/machines/${result.exactMatchId}`);
  if (result?.total === 1) redirect(`/backoffice/machines/${result.items[0].id}`);

  return (
    <>
      <div className="bo-page-head">
        <div>
          <h1>Machines</h1>
          <p>Retrouvez une machine par son numéro de série, quel que soit son lot.</p>
        </div>
      </div>
      <form className="bo-toolbar" action="/backoffice/machines" role="search">
        <div className="bo-field bo-search" style={{ flex: "1 1 420px" }}>
          <label className="bo-label" htmlFor="machine-q">
            Numéro de série
          </label>
          <input
            id="machine-q"
            name="q"
            className="bo-input bo-mono"
            type="search"
            defaultValue={q}
            autoFocus
            autoComplete="off"
            maxLength={100}
            placeholder="Saisissez ou scannez un numéro (machine ou alimentation)"
          />
        </div>
        <button type="submit" className="bo-btn bo-btn-primary">
          Rechercher
        </button>
      </form>
      {!result && (
        <div className="bo-card bo-empty">
          <p>Une partie du numéro suffit. Un numéro exact, ou une seule machine trouvée : sa fiche s&apos;ouvre directement.</p>
        </div>
      )}
      {result?.total === 0 && (
        <div className="bo-card bo-empty">
          <h2>Aucune machine ne correspond à « {q} »</h2>
          <p>Vérifiez le numéro, ou cherchez une partie seulement.</p>
        </div>
      )}
      {result && result.total > 0 && (
        <>
          <p className="bo-muted" role="status" style={{ marginBottom: 12 }}>
            {result.total > result.items.length
              ? `${result.items.length} premières machines sur ${result.total} : précisez la recherche.`
              : `${result.total} machines trouvées.`}
          </p>
          <MachineListGrid machines={result.items} />
        </>
      )}
    </>
  );
}
