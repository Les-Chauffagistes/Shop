"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/backoffice/lots", label: "Lots" },
  { href: "/backoffice/a-traiter", label: "À traiter" },
  { href: "/backoffice/remboursements", label: "Remboursements" },
  { href: "/backoffice/blocages", label: "Blocages" },
  { href: "/backoffice/modeles", label: "Modèles" },
  { href: "/backoffice/pieces", label: "Produits d'options" },
];

export function BackofficeNav() {
  const pathname = usePathname();
  return (
    <nav className="bo-nav" aria-label="Backoffice">
      {LINKS.map((link) => {
        // Une facture s'ouvre depuis « À traiter » : l'onglet reste allumé
        const active =
          pathname === link.href ||
          pathname.startsWith(`${link.href}/`) ||
          (link.href === "/backoffice/a-traiter" && pathname.startsWith("/backoffice/factures/"));
        return (
          <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
