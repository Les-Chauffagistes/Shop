import { getConfig } from "./server/config";

// Une configuration invalide arrête le processus avec un message clair (le conteneur
// échoue) au lieu de servir des 500. Ignoré pendant `next build`, qui s'exécute sans
// les variables d'exécution.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  try {
    getConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
