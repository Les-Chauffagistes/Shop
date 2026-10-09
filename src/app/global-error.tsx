"use client";

/**
 * Dernier recours : erreur dans la mise en page racine, ou dans une page sans error.tsx plus
 * proche. Remplace tout le document, sans les styles globaux : styles en ligne, contrastes
 * vérifiés (texte blanc sur #c2410c, 5,2:1). Aucun détail technique affiché.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="fr">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#f5f5f7",
          color: "#1d1d1f",
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <title>Page indisponible · Les Chauffagistes</title>
        <main style={{ maxWidth: 520, margin: "12vh auto 0", padding: "0 24px", textAlign: "center" }}>
          <p style={{ fontSize: 13, fontWeight: 650, color: "#c2410c", letterSpacing: "0.08em" }}>PAGE INDISPONIBLE</p>
          <h1 style={{ fontSize: 32, fontWeight: 650, margin: "8px 0 12px" }}>Impossible d&apos;afficher cette page</h1>
          <p style={{ color: "#5f5f66", marginBottom: 24, lineHeight: 1.45 }}>
            Le service ne répond pas pour le moment. Réessayez dans quelques instants.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              font: "inherit",
              fontWeight: 600,
              background: "#c2410c",
              color: "#fff",
              border: 0,
              borderRadius: 980,
              padding: "11px 22px",
              cursor: "pointer",
            }}
          >
            Réessayer
          </button>
          {error.digest && (
            <p style={{ color: "#5f5f66", fontSize: 12.5, marginTop: 24 }}>Référence de l&apos;incident : {error.digest}</p>
          )}
        </main>
      </body>
    </html>
  );
}
