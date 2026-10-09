"use client";

import { useLinkStatus } from "next/link";

/**
 * Indicateur de navigation en cours, à placer dans un `<Link>` vers une page dynamique. La boutique
 * n'a pas de `loading.tsx` (il ferait répondre 200 aux pages introuvables) : sans lui, un clic ne
 * montrerait rien tant que le serveur n'a pas répondu. Taille fixe, seule l'opacité change (pas de
 * décalage de mise en page).
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return <span className="shop-link-pending" data-pending={pending ? "true" : undefined} aria-hidden="true" />;
}
