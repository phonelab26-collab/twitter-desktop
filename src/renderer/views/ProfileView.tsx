import { useState, type FormEvent } from 'react';
import type { UserProfile } from '@shared/types';
import { openOnX, useRemote, xapi } from '../api';
import { Avatar } from '../components/Avatar';
import { ErrorBox } from '../components/ErrorBox';
import { Feed } from '../components/Feed';
import { Loading } from '../components/Loading';
import type { TweetActions } from '../components/TweetCard';
import { formatCount, formatJoined } from '../format';

/** Same rule as the main process (service.ts): 1 to 15 letters, digits or underscores. */
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

function ProfileHeader({ profile }: { profile: UserProfile }) {
  const followers = formatCount(profile.followersCount);
  const following = formatCount(profile.friendsCount);
  const posts = formatCount(profile.statusCount);
  const joined = formatJoined(profile.joinedAt);
  return (
    <div className="profile">
      <Avatar
        url={profile.avatarUrl}
        largeUrl={profile.avatarUrl?.replace('_normal.', '_200x200.')}
        handle={profile.screenName}
        size={88}
      />
      <div className="profile-body">
        <h2>
          {profile.name ?? `@${profile.screenName}`}
          {profile.verified && <span className="badge" title="Compte certifié"> ✓</span>}
          {profile.protected && <span className="muted"> 🔒</span>}
        </h2>
        <p className="muted">@{profile.screenName}</p>
        {profile.description && <p className="profile-bio">{profile.description}</p>}
        <p className="profile-meta muted">
          {[profile.location, joined].filter(Boolean).join(' · ')}
        </p>
        <p className="profile-meta">
          {following !== undefined && <span><strong>{following}</strong> abonnements</span>}
          {followers !== undefined && <span><strong>{followers}</strong> abonnés</span>}
          {posts !== undefined && <span><strong>{posts}</strong> posts</span>}
        </p>
        <button type="button" className="link" onClick={() => openOnX(`https://x.com/${profile.screenName}`)}>
          Ouvrir dans Mon X
        </button>
      </div>
    </div>
  );
}

export function ProfileView({ screenName, actions }: { screenName: string | null; actions: TweetActions }) {
  const [draft, setDraft] = useState(screenName ?? '');
  const [inputError, setInputError] = useState<string | null>(null);
  const profile = useRemote(screenName && `profile:${screenName}`, () => xapi().getProfile(screenName ?? ''));
  // Posts are only asked for once the account is known to exist: no wasted request against X's quota.
  const profileFound = profile.status === 'ok' && profile.data !== undefined;
  const tweets = useRemote(profileFound ? `tweets:${screenName}` : null, () => xapi().getUserTweets(screenName ?? ''));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const handle = draft.trim().replace(/^@/, '');
    if (!HANDLE_PATTERN.test(handle)) {
      setInputError('Un nom de compte X fait 1 à 15 caractères : lettres, chiffres ou « _ ».');
      return;
    }
    setInputError(null);
    actions.openProfile(handle);
  };

  return (
    <section>
      <header className="view-header">
        <h1>Profil</h1>
        <form className="search" onSubmit={submit}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="@nom_du_compte"
            aria-label="Nom du compte"
            maxLength={16}
          />
          <button type="submit" className="button">Voir</button>
        </form>
      </header>

      {screenName === null && <p className="notice">Saisis le nom d'un compte X, par exemple @NASA.</p>}
      {inputError && (
        <p className="notice notice-error" role="alert">
          {inputError}
        </p>
      )}
      {profile.status === 'loading' && <Loading label="Chargement du profil…" />}
      {profile.status === 'error' && <ErrorBox error={profile.error} onRetry={profile.reload} />}
      {profile.status === 'ok' && (profile.data ? <ProfileHeader profile={profile.data} /> : <p className="notice">Ce compte n'existe pas ou n'est pas disponible.</p>)}

      {screenName !== null && profile.status === 'ok' && profile.data && (
        <>
          <h3 className="section-title">Derniers posts</h3>
          <Feed
            remote={tweets}
            actions={actions}
            empty="Ce compte n'a publié aucun post visible sans compte."
            end="Sans compte, X n'affiche que ces derniers posts (pas de page suivante)."
          />
        </>
      )}
    </section>
  );
}
