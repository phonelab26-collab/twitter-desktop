/** Display helpers. An unknown value stays visibly unknown: nothing is shown, never 0. */

const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const fullDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
const monthYear = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

export function formatCount(value: number | undefined): string | undefined {
  return value === undefined ? undefined : compact.format(value);
}

/** "3 min", "5 h", "12 oct." like X; undefined for an unknown date. */
export function formatRelative(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return undefined;
  const minutes = Math.floor((now - time) / 60_000);
  // A date in the future (clock skew, bad data) is shown as a date, never as "just now".
  if (minutes < 0) return new Date(time).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('fr-FR', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatFullDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? undefined : fullDate.format(time);
}

export function formatJoined(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? undefined : `A rejoint X en ${monthYear.format(time)}`;
}
