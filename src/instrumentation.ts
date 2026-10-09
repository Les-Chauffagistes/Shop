// Appelé une fois au démarrage du serveur Next.js (voir instrumentation-node.ts).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
