import { useState, type FormEvent } from 'react';
import { useRemote, xapi } from '../api';
import { Feed } from '../components/Feed';
import type { TweetActions } from '../components/TweetCard';

export function TopicView({
  topic,
  actions,
  openTopic,
}: {
  topic: string | null;
  actions: TweetActions;
  openTopic(name: string): void;
}) {
  const [draft, setDraft] = useState(topic ?? '');
  const posts = useRemote(topic && `topic:${topic}`, () => xapi().searchTopic(topic ?? ''));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim()) openTopic(draft.trim());
  };

  return (
    <section>
      <header className="view-header">
        <h1>Sujet</h1>
        <form className="search" onSubmit={submit}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="SpaceX, Macron, Technology…"
            aria-label="Sujet"
            maxLength={100}
          />
          <button type="submit" className="button">Chercher</button>
        </form>
      </header>
      <p className="notice muted">
        Sans compte, X ne permet pas la recherche libre : ce sont les posts populaires qu'il associe à ce sujet.
        Les mots simples (« SpaceX ») marchent mieux que les hashtags.
      </p>
      {topic !== null && <h3 className="section-title">Posts populaires : {topic}</h3>}
      <Feed
        remote={posts}
        actions={actions}
        empty="X n'associe aucun post populaire à ce sujet pour les visiteurs sans compte."
        end="Sans compte, X n'affiche pas plus de posts pour ce sujet."
      />
    </section>
  );
}
