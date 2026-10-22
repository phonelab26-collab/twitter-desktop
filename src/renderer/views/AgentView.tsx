import { useCallback, useEffect, useState } from 'react';
import type { AgentCopyKind, AgentStatus } from '@shared/agent';
import type { ApiResult } from '@shared/types';
import { xapi } from '../api';
import { formatRelative } from '../format';

/** The status is cheap to read (no network): refreshed every 2 s while the tab is open. */
const POLL_MS = 2000;
/** How long a "Copié ✓" stays on its button. */
const COPIED_MS = 3000;
/** The capture's stop reasons (main process, also read by agents in English), for the UI. */
const STOP_REASONS: Readonly<Record<string, string>> = {
  'link turned off': 'lien coupé',
  'window closed': 'fenêtre fermée',
  'x.com view replaced': 'vue x.com remplacée',
  'app quit': 'application fermée',
  'target closed': 'page x.com fermée',
};
const clock = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'medium' });

function ago(iso: string | undefined): string {
  const relative = formatRelative(iso);
  return relative === undefined ? 'jamais' : relative === "à l'instant" ? relative : `il y a ${relative}`;
}

function CopyRow({ label, value, kind, copied, onCopy }: { label: string; value: string; kind: AgentCopyKind; copied: boolean; onCopy(kind: AgentCopyKind): void }) {
  return (
    <div className="agent-row">
      <span className="agent-label">{label}</span>
      <code className="agent-code">{value}</code>
      <button type="button" className="link" onClick={() => onCopy(kind)}>
        {copied ? 'Copié ✓' : 'Copier'}
      </button>
    </div>
  );
}

function Connection({ status, copied, onCopy, onRegenerate }: { status: AgentStatus; copied: AgentCopyKind | null; onCopy(kind: AgentCopyKind): void; onRegenerate(): void }) {
  return (
    <section className="agent-section">
      <h3 className="section-title">Connecter un agent</h3>
      <CopyRow label="Claude Code" value={status.commands.claudeCommand} kind="claudeCommand" copied={copied === 'claudeCommand'} onCopy={onCopy} />
      <CopyRow label="Adresse MCP" value={status.commands.mcpUrl} kind="mcpUrl" copied={copied === 'mcpUrl'} onCopy={onCopy} />
      <CopyRow label="Script (curl)" value={status.commands.curlCommand} kind="curlCommand" copied={copied === 'curlCommand'} onCopy={onCopy} />
      <div className="agent-row">
        <span className="agent-label">Jeton</span>
        <code className="agent-code">••••••••</code>
        <button type="button" className="link" onClick={() => onCopy('token')}>
          {copied === 'token' ? 'Copié ✓' : 'Copier'}
        </button>
        <button type="button" className="link" onClick={onRegenerate}>
          Renouveler
        </button>
      </div>
      <p className="notice muted">
        Lance la commande Claude Code depuis le dossier de ton agent : seul Claude Code ouvert dans ce dossier verra ton fil. Elle contient le
        jeton, qui restera dans l'historique du terminal et dans ~/.claude.json ; le presse-papier, lui, est vidé au bout d'une minute
        {status.clipboardClearsAt ? ` (à ${clock.format(Date.parse(status.clipboardClearsAt))})` : ''} ou à la fermeture de l'app. Pour curl, mets
        d'abord le jeton dans la variable X_DESKTOP_TOKEN. Renouveler le jeton coupe l'accès des agents déjà configurés.
      </p>
      {!status.tokenPersisted && (
        <p className="notice notice-error">Le trousseau n'a pas pu chiffrer le jeton : il sera oublié à la fermeture de l'application.</p>
      )}
    </section>
  );
}

function Capture({ status }: { status: AgentStatus }) {
  const { capture, requests } = status;
  return (
    <section className="agent-section">
      <h3 className="section-title">Capture du fil</h3>
      <ul className="agent-facts">
        <li>
          État : {capture.capturing ? 'en cours' : `arrêtée${capture.stopReason ? ` (${STOP_REASONS[capture.stopReason] ?? capture.stopReason})` : ''}`}
        </li>
        <li>Posts en mémoire : {capture.posts} · dernière capture : {ago(capture.lastCaptureAt)}</li>
        <li>
          x.com à l'écran : {capture.xViewVisible ? 'oui' : 'non'} · sur l'accueil : {capture.onHomeTimeline ? 'oui' : 'non'}
        </li>
        <li>Requêtes de l'agent : {requests.count} · dernière : {ago(requests.lastAt)}</li>
        {capture.personal.length > 0 && <li>Laissés de côté exprès (personnels) : {capture.personal.join(', ')}</li>}
        {capture.unrecognised.length > 0 && <li>Fils non reconnus, donc non lus (X a pu les renommer) : {capture.unrecognised.join(', ')}</li>}
        {capture.unsupported.length > 0 && <li>Réponses dans un format pas encore lu : {capture.unsupported.join(', ')}</li>}
      </ul>
      {!capture.xViewVisible && (
        <p className="notice muted">
          Reviens sur l'onglet Mon X, sur l'accueil : caché, x.com charge moins souvent ton fil, et l'agent ne voit que ce que x.com a chargé.
        </p>
      )}
      {(capture.errors > 0 || capture.unreadablePosts > 0 || capture.bodiesUnavailable > 0) && (
        <p className="notice notice-error">
          {capture.unreadablePosts} post(s) illisible(s) · {capture.bodiesUnavailable} réponse(s) indisponible(s) · {capture.errors} erreur(s)
          {capture.lastError ? ` — dernière : ${capture.lastError}` : ''}
        </p>
      )}
    </section>
  );
}

/**
 * "Agent": read-only access to the X feed of "Mon X" for a local agent
 * (MCP or plain JSON). The token never reaches this page: it is copied by
 * the main process, and turning the link on is confirmed there too.
 */
export function AgentView() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<AgentCopyKind | null>(null);

  /** The answer to an action (turn on, copy...): its error stays until the next action. */
  const apply = useCallback((result: ApiResult<AgentStatus>) => {
    if (result.ok) setStatus(result.data);
    setError(result.ok ? null : result.error.message);
    return result;
  }, []);
  const fail = useCallback((cause: unknown) => setError(String(cause)), []);

  // The refresh only updates the status: it never hides the error of an action.
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      xapi()
        .agent.status()
        .then(
          (result) => {
            if (!alive) return;
            if (result.ok) setStatus(result.data);
            else setError(result.error.message);
          },
          (cause: unknown) => alive && fail(cause),
        );
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [fail]);

  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const toggle = () => {
    if (!status) return;
    setBusy(true);
    xapi().agent.setEnabled(!status.enabled).then(apply, fail).finally(() => setBusy(false));
  };
  const copy = (kind: AgentCopyKind) =>
    xapi().agent.copy(kind).then((result) => apply(result).ok && setCopied(kind), fail);
  const regenerate = () => xapi().agent.regenerateToken().then(apply, fail);

  return (
    <section>
      <header className="view-header">
        <h1>Agent</h1>
      </header>
      <p className="notice muted">
        Donne à un agent (Claude Code, un script…) un accès en lecture seule au fil X que l'onglet Mon X charge : ton accueil, tes recherches,
        tes listes, les communautés et les profils que tu ouvres. Rien n'est demandé en plus à X, rien n'est écrit sur le disque, et
        l'application ne publie, n'aime ni ne passe aucun ordre.
      </p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {status?.settingsIssue && <p className="notice notice-error">{status.settingsIssue}</p>}
      {status && (
        <>
          <div className="toolbar">
            <button type="button" className="button" onClick={toggle} disabled={busy}>
              {status.enabled ? 'Couper le lien agent' : 'Activer le lien agent'}
            </button>
            <span className={status.server.state === 'error' ? 'agent-error' : 'muted'}>
              {status.server.state === 'listening'
                ? `Serveur local en écoute sur ${status.server.url}`
                : (status.server.message ?? 'Lien coupé : aucun agent ne peut lire ton fil.')}
            </span>
          </div>
          {status.enabled && <Connection status={status} copied={copied} onCopy={copy} onRegenerate={regenerate} />}
          <Capture status={status} />
        </>
      )}
      <p className="notice">
        <strong>Prudence.</strong> Les posts sont écrits par n'importe qui et peuvent contenir des instructions piégées : ne laisse pas un agent
        passer un ordre sur la seule foi d'un post, et évite de lui donner aussi un terminal ou un compte de trading. Si l'agent utilise un modèle en
        ligne, les posts qu'il lit partent chez ce fournisseur. Les posts des comptes protégés, ou dont X ne dit pas qu'ils sont publics, ne
        sont jamais transmis ; les publicités sont exclues par défaut.
      </p>
    </section>
  );
}
