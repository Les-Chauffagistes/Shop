import type { Metadata } from "next";
import Link from "next/link";
import { listParts } from "@/server/catalog";
import { listPartStock } from "@/server/part-stock";
import { PartsManager } from "@/components/backoffice/parts/PartsManager";
import { isShort, shortfallSentence } from "@/components/backoffice/stock/pressure";
import { backofficeAccess } from "../_lib/access";

export const metadata: Metadata = { title: "Produits d'options" };

const PATH = "/backoffice/pieces";

/** Vue d'ensemble des produits d'options : catalogue, stock commun et pression de la demande. */
export default async function PartsPage() {
  await backofficeAccess(PATH);
  const [{ items }, { items: stock }] = await Promise.all([listParts(), listPartStock()]);
  const stockById = new Map(stock.map((s) => [s.partId, s]));
  const parts = items.map((p) => ({ ...p, stock: stockById.get(p.id) ?? null }));
  const short = stock.filter(isShort);

  return (
    <>
      <div className="bo-page-head">
        <div>
          <h1>Produits d&apos;options</h1>
          <p>
            Produits achetés tels quels pour les options (ex. Silent kit), partagés entre modèles. Leur stock est commun à
            tous les lots.
          </p>
        </div>
      </div>
      {short.length > 0 ? (
        <div className="bo-alert bo-alert-warning bo-shortages" role="note">
          <strong>
            {short.length > 1 ? `${short.length} produits manquent` : "1 produit manque"} pour la demande ferme des lots
            en cours
          </strong>
          <ul>
            {short.map((s) => (
              <li key={s.partId}>
                <Link href={`/backoffice/pieces/${s.partId}`}>{s.name}</Link> : {shortfallSentence(s)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        stock.length > 0 && (
          <p className="bo-alert bo-alert-success bo-shortages">
            Le stock couvre la demande ferme de tous les lots en cours.
          </p>
        )
      )}
      <PartsManager parts={parts} />
    </>
  );
}
