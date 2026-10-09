"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { buildLoginUrl, type LoginTarget } from "@/lib/login";
import { LinkPending } from "./LinkPending";

/** Lien de connexion qui ramène exactement sur la page courante, requête comprise. */
function LoginLink({ login, pathname }: { login: LoginTarget; pathname: string }) {
  const search = useSearchParams().toString();
  return <a href={buildLoginUrl(login, search ? `${pathname}?${search}` : pathname)}>Se connecter</a>;
}

/**
 * Navigation de la boutique. Le lien de connexion ramène sur la page courante (chemin et requête,
 * rattachés à l'URL publique de la boutique : jamais à l'hôte de la requête). Pendant un
 * prérendu, la requête n'est pas connue : le lien ramène au chemin seul.
 */
export function ShopNav({
  signedIn,
  pseudo,
  isBackoffice,
  login,
}: {
  signedIn: boolean;
  pseudo: string | null;
  isBackoffice: boolean;
  login: LoginTarget;
}) {
  const pathname = usePathname();
  const current = (href: string, exact = false) =>
    (exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)) ? "page" : undefined;

  return (
    <>
      <nav className="shop-nav" aria-label="Boutique">
        <Link href="/" aria-current={current("/", true) ?? current("/lots")}>
          Lots
        </Link>
        <Link href="/mes-interets" aria-current={current("/mes-interets")}>
          Mes intérêts
          <LinkPending />
        </Link>
        <Link href="/mes-commandes" aria-current={current("/mes-commandes")}>
          Mes commandes
          <LinkPending />
        </Link>
        {isBackoffice && <Link href="/backoffice/lots">Backoffice</Link>}
      </nav>
      <div className="shop-account">
        {signedIn ? (
          <span className="bo-muted">{pseudo ?? "Connecté"}</span>
        ) : (
          <Suspense fallback={<a href={buildLoginUrl(login, pathname)}>Se connecter</a>}>
            <LoginLink login={login} pathname={pathname} />
          </Suspense>
        )}
      </div>
    </>
  );
}
