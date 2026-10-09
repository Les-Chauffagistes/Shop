import type { Metadata } from "next";
import { listRefundsToSend } from "@/server/backoffice-orders";
import { RefundsToSend } from "@/components/backoffice/orders/RefundsToSend";
import { backofficeAccess } from "../_lib/access";

export const metadata: Metadata = { title: "Remboursements à envoyer" };

/** Remboursements décidés mais pas encore envoyés, les plus anciens d'abord. */
export default async function RefundsPage() {
  await backofficeAccess("/backoffice/remboursements");
  const { items } = await listRefundsToSend();
  return (
    <>
      <div className="bo-page-head">
        <div>
          <h1>Remboursements à envoyer</h1>
          <p>Envoyez chaque montant depuis le portefeuille de la boutique, puis enregistrez la transaction.</p>
        </div>
      </div>
      <RefundsToSend items={items} />
    </>
  );
}
