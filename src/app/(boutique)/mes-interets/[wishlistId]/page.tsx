import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { getWishlist } from "@/server/wishlists";
import { Configurator } from "@/components/shop/Configurator";
import { OptionWithdrawalNotice, OutdatedChoiceNotice, PriceChangeNotice } from "@/components/shop/PriceChangeNotice";
import { RemoveWishlist } from "@/components/shop/RemoveWishlist";
import { lockedReason } from "@/components/shop/format";
import { formatCents } from "@/lib/decimal";
import { loadOr404 } from "../../../_lib/load";
import { loginTarget, loginUrl, pagePath } from "../../../_lib/login";

export const metadata: Metadata = { title: "Modifier ma configuration" };

/**
 * Modification de la configuration d'une manifestation d'intérêt. Celle d'un autre utilisateur,
 * retirée ou inconnue donne la page 404 (comme l'API : rien n'est révélé). Hors sondage, l'API ne
 * renvoie pas d'offre (`options` null) : la configuration est affichée figée, le retrait reste proposé.
 */
export default async function EditInterestPage({ params, searchParams }: PageProps<"/mes-interets/[wishlistId]">) {
  const { wishlistId } = await params;
  const path = pagePath(`/mes-interets/${encodeURIComponent(wishlistId)}`, await searchParams);
  const user = await getCurrentUser();
  if (!user) redirect(loginUrl(path, "/mes-interets"));
  const wishlist = await loadOr404(wishlistId, (id) => getWishlist(user.id, id));
  const label = `${wishlist.batch.name}, cette machine`;

  return (
    <>
      <nav className="bo-breadcrumb" aria-label="Fil d'Ariane">
        <Link href="/mes-interets">Mes intérêts</Link>
      </nav>
      <div className="shop-page-head">
        <h1>{wishlist.batch.name}</h1>
        <p>Modèle {wishlist.batch.model.name}</p>
        <p>
          Configuration actuelle : {formatCents(wishlist.amount)} (indicatif).
          {wishlist.options !== null && <> Les prix sont relus au moment de l&apos;enregistrement.</>}
        </p>
      </div>

      <OptionWithdrawalNotice withdrawals={wishlist.optionWithdrawals} />
      {wishlist.options === null || wishlist.resaleUnitPrice === null ? (
        <div className="bo-card shop-narrow">
          <h2>La configuration ne se modifie plus</h2>
          <p className="bo-muted">{lockedReason(wishlist)}</p>
          {!wishlist.converted && <OutdatedChoiceNotice items={wishlist.items} editable={false} />}
          <ul className="shop-config-list">
            <li>
              <span>Machine seule</span>
              <span className="bo-num">{formatCents(wishlist.basePrice)}</span>
            </li>
            {wishlist.items.map((item) => (
              <li key={item.optionId} data-default={item.isDefault ? "true" : undefined}>
                <span>
                  {item.optionTitle} : {item.label}
                </span>
                <span className="bo-num">{item.unitPrice === "0" ? "—" : `+ ${formatCents(item.unitPrice)}`}</span>
              </li>
            ))}
          </ul>
          <div className="bo-actions">
            <Link className="bo-btn bo-btn-secondary" href="/mes-interets">
              Retour à mes intérêts
            </Link>
            {wishlist.converted ? (
              wishlist.orderId && (
                <Link className="bo-btn bo-btn-primary" href={`/mes-commandes/${wishlist.orderId}`}>
                  Voir la commande
                </Link>
              )
            ) : (
              <RemoveWishlist
                wishlistId={wishlist.id}
                label={label}
                surveyOpen={wishlist.batch.status === "survey"}
                priorityEndsAt={wishlist.batch.priorityEndsAt}
                afterRemoveHref="/mes-interets"
              />
            )}
          </div>
        </div>
      ) : (
        <div className="shop-narrow bo-stack">
          <PriceChangeNotice basePrice={wishlist.basePrice} resaleUnitPrice={wishlist.resaleUnitPrice} />
          <OutdatedChoiceNotice items={wishlist.items} editable />
          <Configurator
            mode="edit"
            wishlistId={wishlist.id}
            batchId={wishlist.batch.id}
            options={wishlist.options}
            basePrice={wishlist.resaleUnitPrice}
            initialValueIds={wishlist.items.map((i) => i.optionValueId)}
            login={loginTarget()}
          />
        </div>
      )}
    </>
  );
}
