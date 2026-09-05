import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, setToken } from './api';
import type {
  AccountState,
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

export interface AppConfig {
  foldCharLimit: number;
  foldLineLimit: number;
  noteLimit: number;
  hardDailyInviteCap: number;
}

type Tab = 'compose' | 'carousel' | 'drafts' | 'connections' | 'queue';

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
function AccountStrip({
  account,
  onChanged,
}: {
  account: AccountState;
  onChanged: () => void;
}): JSX.Element {
  const invites = account.caps.send_invite;
  const blocked = blockingReason(account);
  const acceptance = account.acceptance;

  const toggle = async (): Promise<void> => {
    if (account.sendingEnabled) await api.pause(account.id, 'Paused by you.');
    else await api.resume(account.id);
    onChanged();
  };

  const canToggle =
    account.sendingEnabled ||
    (account.status !== 'checkpointed' &&
      account.status !== 'restricted' &&
      account.status !== 'disconnected');

  return (
    <>
      <div className="strip">
        <div className="strip-cell">
          <div className="strip-label">Warm-up</div>
          <div className="strip-value">
            day {account.warmupDay} · {account.warmupCap}/day
          </div>
        </div>
        <div className="strip-cell">
          <div className="strip-label">Invites left today</div>
          {/* The one magenta value in the header: the number that decides
              whether anything can be approved right now. */}
          <div className={`strip-value${blocked ? ' alert' : ''}`}>
            {blocked ? 'on hold' : `${invites.remaining} of ${invites.cap}`}
          </div>
        </div>
        <div className="strip-cell">
          <div className="strip-label">Notes left</div>
          <div className="strip-value">
            {account.notesRemaining} of {account.noteAllowance}
            <div className="meta">
              {account.isPremium === null
                ? 'tier unknown'
                : account.isPremium
                  ? 'premium'
                  : 'free · then no-note invites'}
            </div>
          </div>
        </div>
        <div className="strip-cell">
          <div className="strip-label">Acceptance</div>
          <div className="strip-value small">
            {acceptance.rate === null
              ? 'no invites yet'
              : `${Math.round(acceptance.rate * 100)}% (${acceptance.accepted}/${acceptance.sample})`}
            <div className="meta">{BAND_LABEL[acceptance.band]}</div>
          </div>
        </div>
        <div className="strip-cell">
          <div className="strip-label">Next send</div>
          <div className="strip-value small">
            {account.nextScheduledAt
              ? new Date(account.nextScheduledAt).toLocaleString('en-GB', {
                  timeZone: account.timezone,
                  weekday: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'nothing queued'}
            <div className="meta">{account.timezone}</div>
          </div>
        </div>
        <div className="strip-cell" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center' }}>
          <button onClick={() => void toggle()} disabled={!canToggle}>
            {account.sendingEnabled ? 'Pause sending' : 'Resume'}
          </button>
        </div>
      </div>

      {blocked && (
        <div className="banner">
          <strong>Sending is held.</strong> {blocked}
        </div>
      )}
    </>
  );
}

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('compose');
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

  return (
    <div className="app">
      <div className="masthead">
        <h1>PostFold</h1>
        <span className="sub">{account ? account.displayName : '—'}</span>
      </div>

      {fatal && <div className="banner">{fatal}</div>}
      {account && <AccountStrip account={account} onChanged={() => void refresh()} />}

      <div className="tabs" role="tablist">
        {(
          [
            ['compose', 'Compose'],
            ['carousel', 'Carousel'],
            ['drafts', 'Drafts'],
            ['connections', `Connections`],
            ['queue', 'Queue'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className="tab"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'connections' && suggestions.length > 0 && (
              <span className="count"> {suggestions.length}</span>
            )}
            {id === 'drafts' && drafts.length > 0 && (
              <span className="count"> {drafts.length}</span>
            )}
            {id === 'queue' && pending.length > 0 && <span className="count"> {pending.length}</span>}
          </button>
        ))}
      </div>

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

      {tab === 'drafts' && account && (
        <Drafts
          account={account}
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
    </div>
  );
}
