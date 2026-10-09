import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/server/auth";
import { getPublicBatch } from "@/server/shop";
import { listWishlists } from "@/server/wishlists";
import { formatCents, formatHashrate } from "@/lib/decimal";
import { formatDateTime } from "@/lib/dates";
import { StatusBadge } from "@/components/backoffice/StatusBadge";
import { Configurator } from "@/components/shop/Configurator";
import { LinkPending } from "@/components/shop/LinkPending";
import { isFuture } from "@/components/shop/format";
import { machines } from "@/lib/plural";
import { loadOr404 } from "../../../_lib/load";
import { loginTarget } from "../../../_lib/login";

export const metadata: Metadata = { title: "Fiche produit" };

/** Paramètre d'URL facultatif (premier si répété). */
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Fiche produit d'un lot public. Au sondage : configuration et manifestation d'intérêt
 * (`?choix=<valeur>,<valeur>&quantite=N` préremplit la configuration : c'est l'adresse de retour
 * après la connexion, pour ne pas perdre la saisie). Lot ouvert aux commandes (`acceptsOrders`) :
 * l'action principale est « Commander », qui mène à la page de commande.
 */
export default async function BatchProductPage({ params, searchParams }: PageProps<"/lots/[batchId]">) {
  const { batchId } = await params;
  const sp = await searchParams;
  const batch = await loadOr404(batchId, getPublicBatch);
  const user = await getCurrentUser();
  const mine = user ? (await listWishlists(user.id, { batchId: batch.id })).items.length : 0;

  const quantity = Number(first(sp.quantite));
  // Journée de priorité encore en cours (l'API donne la fin, éventuellement passée)
  const priorityRunning = isFuture(batch.priorityEndsAt);
  const initialValueIds = (first(sp.choix) ?? "").split(",").filter(Boolean);
  // Plus aucune machine disponible (le serveur refuserait une commande : « Le stock du lot est épuisé »)
  const soldOut = batch.acceptsOrders && batch.availableQuantity === 0;

  return (
    <>
      <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
        <Link href="/">Lots</Link>
      </nav>
      <div className="shop-product">
        <section className="shop-product-intro" aria-labelledby="modele">
          <p className="shop-eyebrow">
            <StatusBadge status={batch.status} />
            <span className="shop-lot-name">{batch.name}</span>
          </p>
          <h1 id="modele">{batch.model.name}</h1>
          <p className="shop-product-spec">{formatHashrate(batch.model.hashrate)}</p>
          {batch.model.description && <p className="shop-product-desc">{batch.model.description}</p>}
          <dl className="shop-facts">
            <div>
              <dt>Prix unitaire</dt>
              <dd className="bo-num">{formatCents(batch.resaleUnitPrice)}</dd>
              <dd className="bo-hint">Machine seule, hors options</dd>
            </div>
            <div>
              <dt>Disponibles dans ce lot</dt>
              <dd className="bo-num">{machines(batch.availableQuantity)}</dd>
            </div>
            {batch.acceptsOrders ? (
              <div>
                <dt>Par commande</dt>
                <dd className="bo-num">Jusqu&apos;à {machines(batch.maxMachinesPerOrder)}</dd>
              </div>
            ) : (
              <div>
                <dt>Par personne</dt>
                <dd className="bo-num">Jusqu&apos;à {machines(batch.wishlistLimit)}</dd>
              </div>
            )}
          </dl>
        </section>

        {batch.acceptsOrders ? (
          <section className="shop-config" aria-labelledby="commander">
            <h2 id="commander">
              {soldOut
                ? "Lot épuisé"
                : batch.status === "tuning" || batch.status === "packaging"
                  ? "Commandes ouvertes"
                  : "Précommandes ouvertes"}
            </h2>
            {soldOut && (
              <div className="bo-alert bo-alert-warning" role="note">
                Toutes les machines de ce lot sont vendues ou réservées. Une place peut se libérer (facture non payée qui
                expire, commande annulée) : tant que le lot est épuisé, une commande est refusée.
              </div>
            )}
            <p>
              Choisissez vos machines et leurs options, indiquez vos adresses, puis payez la facture en bitcoins.
              Votre machine est réservée 30 minutes à partir de la création de la facture.
            </p>
            {priorityRunning && (
              <div className="bo-alert bo-alert-info" role="note">
                Jusqu&apos;au {formatDateTime(batch.priorityEndsAt!)}, les commandes sont réservées aux personnes qui ont
                manifesté leur intérêt pendant le sondage, pour le nombre de machines qu&apos;elles avaient souhaité.
              </div>
            )}
            <div className="shop-summary">
              <div className="shop-summary-line">
                <span>À partir de</span>
                <strong className="bo-num">{formatCents(batch.resaleUnitPrice)}</strong>
              </div>
              <p className="bo-hint">Prix par machine, hors options. Le montant exact est calculé sur la facture.</p>
            </div>
            <Link className="bo-btn bo-btn-primary shop-cta" href={`/lots/${batch.id}/commander`}>
              Commander
              <LinkPending />
            </Link>
            {user === null && (
              <p className="bo-hint shop-center">Connexion requise : vous serez renvoyé ici ensuite.</p>
            )}
          </section>
        ) : (
        <Configurator
          mode="create"
          batchId={batch.id}
          options={batch.options}
          basePrice={batch.resaleUnitPrice}
          initialValueIds={initialValueIds}
          initialQuantity={Number.isInteger(quantity) && quantity >= 1 && quantity <= 100 ? quantity : 1}
          signedIn={user !== null}
          alreadyInterested={mine}
          wishlistLimit={batch.wishlistLimit}
          login={loginTarget()}
        />
        )}
        <section className="shop-explain" aria-labelledby="fonctionnement">
          <h2 id="fonctionnement">Comment ça marche ?</h2>
          {batch.acceptsOrders ? (
            <ol>
              <li>Vous configurez une ou plusieurs machines et créez la facture : les machines sont réservées 30 minutes.</li>
              <li>Vous payez le montant indiqué en bitcoins, à l&apos;adresse propre à votre facture.</li>
              <li>
                Vous suivez votre commande depuis « Mes commandes » jusqu&apos;à l&apos;expédition. Tant que le lot est en
                précommande, vous pouvez y renoncer (les frais du réseau Bitcoin restent à votre charge).
              </li>
            </ol>
          ) : (
            <ol>
              <li>Pendant le sondage, vous indiquez les machines qui vous intéressent et leurs options. Rien à payer.</li>
              <li>Si le lot est confirmé, les précommandes ouvrent : vous êtes prioritaire pour précommander.</li>
              <li>
                Depuis « Mes intérêts », vous pouvez modifier votre configuration pendant le sondage, et retirer votre
                intérêt à tout moment.
              </li>
            </ol>
          )}
        </section>
      </div>
    </>
  );
}
