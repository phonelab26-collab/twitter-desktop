import type { ApiError } from '@shared/types';

/** What each error code means for the person using the app. */
const MESSAGES: Record<string, string> = {
  USER_NOT_FOUND: "Ce compte n'existe pas.",
  PROTECTED_ACCOUNT: 'Ce compte est protégé : ses posts ne sont pas visibles sans compte.',
  INVALID_INPUT: 'Saisie invalide.',
  NOT_FOUND: "X ne connaît pas cet élément.",
  NETWORK_ERROR: 'Impossible de joindre X. Vérifie ta connexion.',
  TIMEOUT: 'X met trop de temps à répondre.',
  GUEST_TOKEN_UNAVAILABLE: "X refuse l'accès invité pour le moment.",
  UNEXPECTED_SHAPE: "X a changé le format de ses réponses : l'application doit être mise à jour.",
  BAD_RESPONSE: 'Réponse de X illisible.',
  PARTIAL_RESPONSE: 'X a répondu avec des erreurs : les données seraient incomplètes.',
  RATE_LIMITED: 'Trop de requêtes : réessaie dans quelques minutes.',
  HTTP_ERROR: 'X a répondu par une erreur.',
  DISCOVERY_FAILED: "Impossible de retrouver les identifiants de X pour le moment.",
  PAGE_UNAVAILABLE: "x.com n'a pas fourni les données de cette page pour le moment.",
  OPERATION_NOT_DEPLOYED: "X n'expose plus cette fonction aux visiteurs sans compte.",
};

export function ErrorBox({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const known = error.code ? MESSAGES[error.code] : undefined;
  const rateLimited = error.status === 429;
  return (
    <div className="notice notice-error" role="alert">
      <p className="notice-title">
        {rateLimited ? 'Trop de requêtes : X limite le débit, réessaie dans quelques minutes.' : (known ?? 'Une erreur est survenue.')}
      </p>
      {known || rateLimited ? (
        // The French title says it; the technical message stays one click away for bug reports.
        <details className="notice-detail">
          <summary>Détails techniques</summary>
          {error.message}
        </details>
      ) : (
        <p className="notice-detail">{error.message}</p>
      )}
      {onRetry && (error.retriable || rateLimited) && (
        <button type="button" className="button" onClick={onRetry}>
          Réessayer
        </button>
      )}
    </div>
  );
}
