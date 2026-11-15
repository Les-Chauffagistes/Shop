import Link from "next/link";
import { connection } from "next/server";
import { listPublicBatches } from "@/server/shop";
import { formatCents, formatHashrate } from "@/lib/decimal";
import { machines } from "@/lib/plural";
import { StatusBadge } from "@/components/backoffice/StatusBadge";
import { LinkPending } from "@/components/shop/LinkPending";

type PublicBatch = Awaited<ReturnType<typeof listPublicBatches>>["items"][number];

function BatchCard({ batch }: { batch: PublicBatch }) {
  return (
    <li className="shop-card">
      <p className="shop-eyebrow">
        <StatusBadge status={batch.status} label={batch.statusLabel} />
        <span className="shop-lot-name">{batch.name}</span>
      </p>
      <h3>
        <Link href={`/lots/${batch.id}`} className="shop-card-link">
          {batch.model.name}
          <LinkPending />
        </Link>
      </h3>
      <p className="shop-card-spec">{formatHashrate(batch.model.hashrate)}</p>
      {batch.model.description && <p className="shop-card-desc">{batch.model.description}</p>}
      <dl className="shop-card-facts">
        <div>
          <dt>Prix unitaire</dt>
          <dd className="bo-num">{formatCents(batch.resaleUnitPrice)}</dd>
        </div>
        <div>
          <dt>Disponibles</dt>
          <dd className="bo-num">
            {batch.acceptsOrders && batch.availableQuantity === 0 ? "Épuisé" : machines(batch.availableQuantity)}
          </dd>
        </div>
      </dl>
      <span className="shop-card-cta" aria-hidden="true">
        {batch.acceptsOrders ? "Commander ›" : "Découvrir ›"}
      </span>
    </li>
  );
}

/** Section de l'accueil : un titre et ses lots (rien si elle est vide). */
function Section({ id, title, batches }: { id: string; title: string; batches: PublicBatch[] }) {
  if (batches.length === 0) return null;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="shop-section-title">
        {title}
      </h2>
      <ul className="shop-cards">
        {batches.map((batch) => (
          <BatchCard key={batch.id} batch={batch} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Accueil de la boutique : machines en stock (commande directe), lots ouverts aux commandes (Précommande et
 * suivants), puis lots au sondage, du plus récent au plus ancien dans chaque groupe (ordre de l'API).
 */
export default async function ShopHome() {
  await connection(); // liste lue à chaque requête (statuts changés par le backoffice)
  const { items } = await listPublicBatches();
  const stock = items.filter((b) => b.kind === "stock");
  const open = items.filter((b) => b.kind !== "stock" && b.acceptsOrders);
  const survey = items.filter((b) => b.kind !== "stock" && !b.acceptsOrders);

  return (
    <>
      <section className="shop-hero" aria-labelledby="titre">
        <h1 id="titre">Des mineurs achetés en lot, revendus à l&apos;unité.</h1>
        <p>
          Commandez une machine en stock, ou indiquez celles qui vous intéressent pendant le sondage d&apos;un lot, sans
          rien payer : vous serez prioritaire à l&apos;ouverture des précommandes.
        </p>
      </section>

      {items.length === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Aucun lot disponible pour le moment</h2>
          <p>Les prochains lots apparaîtront ici dès leur publication. Revenez bientôt.</p>
        </div>
      ) : (
        <div className="shop-sections">
          <Section id="lots-stock" title="En stock, commandez" batches={stock} />
          <Section id="lots-ouverts" title="Commandes ouvertes" batches={open} />
          <Section id="lots-sondage" title="En sondage" batches={survey} />
        </div>
      )}
    </>
  );
}
