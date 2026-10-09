import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { listWishlists } from "@/server/wishlists";
import { StatusBadge } from "@/components/backoffice/StatusBadge";
import { Notice } from "@/components/backoffice/ui";
import { LinkPending } from "@/components/shop/LinkPending";
import { OptionWithdrawalNotice, OutdatedChoiceNotice, PriceChangeNotice } from "@/components/shop/PriceChangeNotice";
import { RemoveWishlist } from "@/components/shop/RemoveWishlist";
import { lockedReason } from "@/components/shop/format";
import { machines } from "@/lib/plural";
import { formatCents } from "@/lib/decimal";
import { formatDate } from "@/lib/dates";
import { loginUrl, pagePath } from "../../_lib/login";

export const metadata: Metadata = { title: "Mes intérêts" };

/** Wishlist de l'API (`batch.name` : nom du lot, affiché en titre ; le modèle en secondaire). */
type Wishlist = Awaited<ReturnType<typeof listWishlists>>["items"][number];

/** Manifestations d'intérêt actives de l'utilisateur, regroupées par lot (le plus récent d'abord). */
export default async function MyInterestsPage({ searchParams }: PageProps<"/mes-interets">) {
  const sp = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(loginUrl(pagePath("/mes-interets", sp), "/mes-interets"));
  const { modifie } = sp;
  const { items } = await listWishlists(user.id, {});

  const groups = new Map<string, Wishlist[]>();
  for (const w of items) groups.set(w.batch.id, [...(groups.get(w.batch.id) ?? []), w]);

  return (
    <>
      <div className="shop-page-head">
        <h1>Mes intérêts</h1>
        <p>Les machines que vous souhaitez, lot par lot. Aucun paiement n&apos;a été demandé.</p>
      </div>
      <Notice
        message={
          typeof modifie === "string" && items.some((w) => w.id === modifie) ? "Configuration enregistrée." : null
        }
      />

      {groups.size === 0 ? (
        <div className="bo-card bo-empty">
          <h2>Aucun intérêt pour l&apos;instant</h2>
          <p>Parcourez les lots en sondage et indiquez les machines qui vous intéressent, sans rien payer.</p>
          <Link className="bo-btn bo-btn-primary" href="/">
            Voir les lots disponibles
          </Link>
        </div>
      ) : (
        <div className="bo-stack">
          {[...groups.values()].map((list) => {
            const batch = list[0].batch;
            const open = batch.isPublic;
            // Lot ouvert aux commandes (batch_accepts_orders, donné par l'API) : les machines souhaitées non commandées
            // peuvent y être reprises
            const orderable = batch.acceptsOrders && list.some((w) => !w.converted);
            return (
              <section key={batch.id} className="bo-card shop-interest" aria-labelledby={`lot-${batch.id}`}>
                <div className="bo-card-head">
                  <div>
                    <h2 id={`lot-${batch.id}`} className="shop-interest-title">
                      {batch.name} <StatusBadge status={batch.status} />
                    </h2>
                    <p>
                      {batch.model.name} · {machines(list.length)} souhaitée{list.length > 1 ? "s" : ""}
                    </p>
                  </div>
                  <div className="bo-actions">
                    {open && (
                      <Link className="bo-btn bo-btn-secondary bo-btn-sm" href={`/lots/${batch.id}`}>
                        Voir le lot
                        <LinkPending />
                      </Link>
                    )}
                    {orderable && (
                      <Link
                        className="bo-btn bo-btn-primary bo-btn-sm"
                        href={`/lots/${batch.id}/commander`}
                        aria-label={`Commander sur ${batch.name}`}
                      >
                        Commander
                        <LinkPending />
                      </Link>
                    )}
                  </div>
                </div>
                <ol className="shop-machines">
                  {list.map((w, i) => {
                    const label = `${batch.name}, machine n° ${i + 1}`;
                    return (
                      <li key={w.id} className="shop-machine" data-highlight={w.id === modifie ? "true" : undefined}>
                        <div className="shop-machine-main">
                          <h3>
                            Machine n° {i + 1}
                            {w.converted && <span className="bo-badge bo-badge-done">Commandée</span>}
                          </h3>
                          <ul className="shop-config-list">
                            <li>
                              <span>Machine seule</span>
                              <span className="bo-num">{formatCents(w.basePrice)}</span>
                            </li>
                            {w.items.map((item) => (
                              <li key={item.optionId} data-default={item.isDefault ? "true" : undefined}>
                                <span>
                                  {item.optionTitle} : {item.label}
                                </span>
                                <span className="bo-num">
                                  {item.unitPrice === "0" ? "—" : `+ ${formatCents(item.unitPrice)}`}
                                </span>
                              </li>
                            ))}
                          </ul>
                          <OptionWithdrawalNotice withdrawals={w.optionWithdrawals} />
                          <PriceChangeNotice basePrice={w.basePrice} resaleUnitPrice={w.resaleUnitPrice} />
                          {!w.converted && <OutdatedChoiceNotice items={w.items} editable={w.editable} />}
                          <p className="bo-hint">
                            Depuis le {formatDate(w.createdAt)}
                            {!w.editable && <> · {lockedReason(w)}</>}
                          </p>
                        </div>
                        <div className="shop-machine-side">
                          <p className="shop-machine-amount bo-num">
                            {formatCents(w.amount)}
                            <small>indicatif</small>
                          </p>
                          <div className="bo-actions">
                            {w.editable && (
                              <Link
                                className="bo-btn bo-btn-secondary bo-btn-sm"
                                href={`/mes-interets/${w.id}`}
                                aria-label={`Modifier ${label}`}
                              >
                                Modifier
                                <LinkPending />
                              </Link>
                            )}
                            {w.converted ? (
                              w.orderId && (
                                <Link
                                  className="bo-btn bo-btn-secondary bo-btn-sm"
                                  href={`/mes-commandes/${w.orderId}`}
                                  aria-label={`Voir la commande de ${label}`}
                                >
                                  Voir la commande
                                  <LinkPending />
                                </Link>
                              )
                            ) : (
                              <RemoveWishlist
                                wishlistId={w.id}
                                label={label}
                                surveyOpen={batch.status === "survey"}
                                priorityEndsAt={batch.priorityEndsAt}
                              />
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
