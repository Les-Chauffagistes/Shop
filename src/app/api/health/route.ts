import { getDb } from "@/server/db";

const DB_TIMEOUT_MS = 3_000;
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Healthcheck Docker Swarm : 200 si la base répond, 503 sinon. Public, sans détail.
 * Jamais prérendu : un GET qui interroge la base s'exécute à chaque requête.
 */
export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      getDb().$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS);
      }),
    ]);
    return Response.json({ status: "ok" }, { headers: NO_STORE });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: NO_STORE });
  } finally {
    clearTimeout(timer);
  }
}
