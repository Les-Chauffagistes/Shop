/** Dates affichées à l'heure de Paris, identiques côté serveur et navigateur (pas d'écart d'hydratation). */
const dateTime = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

const shortDateTime = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Variante compacte pour les grilles (« 6 oct., 13:55 »). */
export function formatShortDateTime(iso: string): string {
  return shortDateTime.format(new Date(iso));
}

const time = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });

/** Heure seule (« 14:32 »), pour une confirmation d'enregistrement. */
export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

const date = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "short", year: "numeric" });

/** Date seule (« 6 oct. 2026 »). */
export function formatDate(iso: string): string {
  return date.format(new Date(iso));
}
