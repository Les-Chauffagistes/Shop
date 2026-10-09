import type { NextConfig } from "next";

/**
 * En-têtes de sécurité, sur toutes les réponses (pages, API, fichiers statiques).
 *
 * CSP volontairement partielle : seules les directives sans incidence sur les scripts et les
 * styles. Une CSP `script-src` sans `'unsafe-inline'` impose un nonce par requête (proxy), donc le
 * rendu dynamique de toutes les pages ; et Ag Grid pose des styles en ligne (`style-src
 * 'unsafe-inline'` obligatoire). Une CSP `script-src 'self' 'unsafe-inline'` n'apporterait
 * presque rien contre le XSS : à reconsidérer avec les nonces si le besoin apparaît.
 * HSTS est posé par le proxy TLS du Swarm (l'application ne voit que du HTTP).
 */
const securityHeaders = [
  // Anti-clickjacking (boutons de transition du backoffice) : les deux formes, ancienne et CSP
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // forbidden() : vrai statut 403 pour le refus d'accès au backoffice (src/app/backoffice/_lib/access.tsx)
  experimental: { authInterrupts: true },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
