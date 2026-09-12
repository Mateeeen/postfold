import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, setToken } from './api';
import type {
  AccountState,
  Config,
  DraftCard,
  Keyword,
  LastSearch,
  PostRow,
  QueueItem,
  SuggestionCard,
} from './api';
import { Composer, Carousel } from './PostFold';
import { Connections, blockingReason } from './Connections';
import { Queue } from './Queue';
import { Drafts } from './Drafts';
import { Today } from './Today';
import { Profile } from './Profile';
import { Home } from './Home';
import { Settings } from './Settings';
import { Published } from './Published';
import { Comments } from './Comments';
import { Trending } from './Trending';
import { Avatar } from './PostCard';

export type AppConfig = Config;

type Tab =
  | 'home'
  | 'settings'
  | 'today'
  | 'compose'
  | 'carousel'
  | 'comments'
  | 'trending'
  | 'drafts'
  | 'connections'
  | 'published'
  | 'queue';

const BAND_LABEL: Record<AccountState['acceptance']['band'], string> = {
  unrated: 'not enough data yet',
  healthy: 'healthy',
  watch: 'watch',
  throttled: 'throttled',
  critical: 'critical',
};

/**
 * Account state, always visible. Warm-up day, invites left today, acceptance
 * rate with its band, and the next scheduled send — the four things that
 * explain why the queue is behaving the way it is.
 */
/**
 * Can sending be turned back on?
 *
 * A checkpointed, restricted or disconnected account may always be paused and
 * never resumed from here - recovering from those requires dealing with the
 * platform first. Shared so the rail switch and the strip cannot disagree
 * about whether the button works.
 */
function canToggleSending(account: AccountState): boolean {
  return (
    account.sendingEnabled ||
    (account.status !== 'checkpointed' &&
      account.status !== 'restricted' &&
      account.status !== 'disconnected')
  );
}


export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('home');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionCard[]>([]);
  const [pending, setPending] = useState<QueueItem[]>([]);
  const [recent, setRecent] = useState<QueueItem[]>([]);
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [drafts, setDrafts] = useState<DraftCard[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [commentLimit, setCommentLimit] = useState(1250);
  const [lastSearch, setLastSearch] = useState<LastSearch | null>(null);
  const [searchPending, setSearchPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [suggestionsRes, queueRes, postsRes, draftsRes, keywordsRes] = await Promise.all([
        api.suggestions(),
        api.queue(),
        api.posts(),
        api.drafts(),
        api.keywords(),
      ]);
      setAccount(suggestionsRes.account);
      setSuggestions(suggestionsRes.suggestions);
      setPending(queueRes.pending);
      setRecent(queueRes.recent);
      setPosts(postsRes);
      setDrafts(draftsRes.drafts);
      setCommentLimit(draftsRes.commentLimit);
      setLastSearch(draftsRes.lastSearch);
      setSearchPending(draftsRes.searchPending);
      setKeywords(keywordsRes.keywords);
      setFatal(null);
    } catch (e) {
      setFatal(
        e instanceof ApiError && e.status === 401
          ? 'unauthorised'
          : e instanceof ApiError && e.status === 404
            ? 'No account connected yet. Run `npm run seed` to create the test account.'
            : 'Could not reach the PostFold API. Is the server running?',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setConfig(await api.config());
      } catch (e) {
        setFatal(
          e instanceof ApiError && e.status === 401
            ? 'unauthorised'
            : 'Could not reach the PostFold API. Is the server running?',
        );
      }
      await refresh();
    })();
  }, [refresh]);

  // The queue moves on its own — the worker sends on a schedule — so the view
  // has to keep up with it without the user reloading.
  useEffect(() => {
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const queuePost = useCallback(
    async (text: string): Promise<string | null> => {
      try {
        await api.createPost(text);
        await refresh();
        return null;
      } catch (e) {
        if (e instanceof ApiError) return e.reason ?? e.message;
        return 'Could not queue that post.';
      }
    },
    [refresh],
  );

  const syncEngagers = async (urn: string): Promise<void> => {
    try {
      await api.syncEngagers(urn);
    } catch {
      /* the reason surfaces on the next refresh; nothing destructive happened */
    }
    await refresh();
  };

  // A deployed API is token-gated. Ask for it rather than showing an app
  // whose every request will fail.
  if (fatal === 'unauthorised') {
    return (
      <div className="app">
        <div className="masthead">
          <h1>PostFold</h1>
        </div>
        <div className="panel" style={{ maxWidth: 420 }}>
          <h2>Access token</h2>
          <p className="meta" style={{ marginBottom: 10 }}>
            This instance is protected. Paste the APP_TOKEN it was deployed with.
          </p>
          <input
            type="password"
            value={tokenInput}
            placeholder="APP_TOKEN"
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tokenInput.trim() !== '') {
                setToken(tokenInput.trim());
                window.location.reload();
              }
            }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="primary"
              disabled={tokenInput.trim() === ''}
              onClick={() => {
                setToken(tokenInput.trim());
                window.location.reload();
              }}
            >
              Unlock
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Grouped by what each destination is for, not by what it contains. "Needs
  // you" is the automation's output waiting on a decision; "Make something" is
  // work the user starts; "Machinery" is the parts that run themselves and are
  // only opened when something looks wrong.
  const NAV: { group: string | null; items: [Tab, string][] }[] = [
    { group: 'Engagement', items: [['comments', 'Comments'], ['connections', 'People']] },
    { group: 'Make something', items: [['trending', 'Trending']] },
    { group: 'Needs you', items: [['drafts', 'Review']] },
    // Unlabelled: two rows do not need a heading to explain them, and a
    // heading per item is how a five-link sidebar starts feeling like a CRM.
    {
      group: null,
      items: [
        ['carousel', 'Carousel'],
        ['published', 'Your posts'],
        ['queue', 'Scheduled'],
        ['settings', 'Settings'],
      ],
    },
  ];

  const badge = (id: Tab): number => {
    if (id === 'drafts') return drafts.length;
    if (id === 'connections') return suggestions.length;
    if (id === 'queue') return pending.length;
    return 0;
  };

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-top">
          <div className="wordmark">PostFold</div>

          {/* One loud action, above the navigation rather than inside it -
              writing is the thing this product is for. */}
          <button
            className="rail-cta"
            onClick={() => setTab('compose')}
            aria-current={tab === 'compose' ? 'page' : undefined}
          >
            Write a post
          </button>

          <nav className="rail-nav">
            <button
              className="rail-link"
              aria-current={tab === 'home' ? 'page' : undefined}
              onClick={() => setTab('home')}
            >
              Home
              {drafts.length + suggestions.length > 0 && (
                <span className="rail-badge">{drafts.length + suggestions.length}</span>
              )}
            </button>

            {NAV.map(({ group, items }) => (
              <div className="rail-group" key={group ?? 'plain'}>
                {group && <div className="rail-group-label">{group}</div>}
                {items.map(([id, label]) => (
                  <button
                    key={id}
                    className="rail-link"
                    aria-current={tab === id ? 'page' : undefined}
                    onClick={() => setTab(id)}
                  >
                    {label}
                    {badge(id) > 0 && <span className="rail-badge">{badge(id)}</span>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </div>

        {/* Whose account this acts as, and whether it is acting. Anchored at
            the bottom because it is a standing fact, not a destination. */}
        {account && (
          <div className="rail-foot">
            <Avatar
              who={{
                name: account.profile.name,
                headline: account.profile.headline,
                avatarUrl: account.profile.avatarUrl,
                profileUrl: null,
              }}
              size={30}
            />
            <div className="rail-me">
              <span className="rail-me-name">{account.profile.name}</span>
              {/* The switch lives with the indicator, and on every screen: the
                  moment you want to stop this thing is not the moment to go
                  looking for where the control lives. */}
              <button
                className="rail-me-state"
                disabled={!canToggleSending(account)}
                title={
                  canToggleSending(account)
                    ? undefined
                    : 'Sending cannot be resumed until the account is healthy again.'
                }
                onClick={() => {
                  void (async () => {
                    if (account.sendingEnabled) await api.pause(account.id, 'Paused by you.');
                    else await api.resume(account.id);
                    refresh();
                  })();
                }}
              >
                <span className={account.sendingEnabled ? 'dot live' : 'dot held'} />
                {account.sendingEnabled ? 'Running' : 'Paused'}
              </button>
            </div>
          </div>
        )}
      </aside>

      <main className="content">
        {fatal && <div className="banner">{fatal}</div>}

      {tab === 'settings' && account && (
        <Settings account={account} onChanged={() => void refresh()} />
      )}

      {tab === 'home' && (
        <Home
          onOpen={(item) => setTab(item.kind === 'invite' ? 'connections' : 'drafts')}
          onChanged={() => setTab('compose')}
        />
      )}

      {tab === 'today' && account && config && (
        <>
        <Profile account={account} onChanged={() => void refresh()} />
        <Today
          account={account}
          config={config}
          drafts={drafts}
          suggestions={suggestions}
          pending={pending}
          onGo={setTab}
          onChanged={() => void refresh()}
        />
        </>
      )}

      {tab === 'compose' && config && (
        <>
          <Composer config={config} onQueuePost={queuePost} />
          {posts.length > 0 && (
            <div className="panel" style={{ marginTop: 18 }}>
              <h2>Published</h2>
              <div className="cards">
                {posts
                  .filter((p) => p.status === 'published' && p.urn)
                  .map((p) => (
                    <div key={p.id} className="queue-row">
                      <span className="label">{p.text.split('\n')[0]}</span>
                      <button onClick={() => void syncEngagers(p.urn as string)}>
                        Pull engagers
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'carousel' && <Carousel />}

      {tab === 'trending' && account && config && (
        <Trending
          account={account}
          config={config}
          onChanged={() => void refresh()}
          onGo={setTab}
        />
      )}

      {tab === 'comments' && account && config && (
        <Comments
          account={account}
          config={config}
          keywords={keywords}
          onChanged={() => void refresh()}
          onGo={setTab}
        />
      )}

      {tab === 'published' && account && (
        <Published account={account} onChanged={() => void refresh()} />
      )}

      {tab === 'drafts' && account && config && (
        <Drafts
          account={account}
          foldCharLimit={config.foldCharLimit}
          drafts={drafts}
          keywords={keywords}
          commentLimit={commentLimit}
          lastSearch={lastSearch}
          searchPending={searchPending}
          loading={loading}
          onChanged={() => void refresh()}
        />
      )}

      {tab === 'connections' && account && config && (
        <Connections
          account={account}
          suggestions={suggestions}
          noteLimit={config.noteLimit}
          loading={loading}
          onChanged={() => void refresh()}
        />
      )}

      {tab === 'queue' && account && (
        <Queue
          account={account}
          pending={pending}
          recent={recent}
          loading={loading}
          onChanged={() => void refresh()}
        />
      )}
      </main>
    </div>
  );
}
