// Validation de la configuration avant la migration (docker/entrypoint.sh). Même schéma que
// l'application (src/server/config.ts), empaqueté en un fichier autonome au build de l'image :
// un conteneur mal configuré s'arrête ici, avec le message de configuration, avant de toucher la base.
import { getConfig } from "../src/server/config";

try {
  getConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
