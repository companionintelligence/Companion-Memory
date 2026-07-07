/**
 * Self-contained GraphiQL IDE (https://github.com/graphql/graphiql) served at
 * `GET /graphiql` (reachable from the browser as `/api/graphiql`, the reverse
 * proxy strips the `/api` prefix).
 *
 * The markup is inlined as a string rather than shipped as a static `.html`
 * asset on purpose: the API build is `tsc` only (no asset-copy step) and the
 * Docker image ships just `dist`, so a sibling `.html` would 404 in production.
 * A `.ts` module compiles into `dist` like any other file.
 *
 * Theming: GraphiQL 2.x reads its palette from HSL-component custom properties
 * (`--color-base`, `--color-neutral`, `--color-primary/secondary/tertiary`,
 * consumed via `hsla(var(--…), a)`), toggling `body.graphiql-dark` /
 * `body.graphiql-light`. We default to dark and override those variables with
 * the Companion Intelligence palette (mint #58ebbf → teal #409b9b → aqua
 * #00a9a7 on the ink #041620 ground) so the IDE reads as CI-branded. The custom
 * API-key bar reuses the same tokens (mint→teal brand gradient, teal borders).
 *
 * Auth: the CI GraphQL API accepts an `x-api-key` header (see ApiKeyStrategy /
 * JwtOrApiKeyAuthGuard). The user pastes a key created under
 * Settings → API Keys; it is persisted in localStorage and attached to every
 * request. A `Bearer` token from `accessToken` is also sent when present so an
 * existing session keeps working.
 */
const GRAPHIQL_VERSION = '2.4.5';

export const GRAPHIQL_HTML = /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GraphiQL · Companion Intelligence</title>
    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%23041620'/%3E%3Ccircle cx='16' cy='16' r='7' fill='none' stroke='%2358ebbf' stroke-width='3'/%3E%3C/svg%3E"
    />
    <link rel="stylesheet" href="https://unpkg.com/graphiql@${GRAPHIQL_VERSION}/graphiql.min.css" />
    <style>
      :root {
        color-scheme: dark;
        /* Companion Intelligence brand tokens */
        --ci-mint: #58ebbf;
        --ci-mint-hover: #82ffe1;
        --ci-teal: #409b9b;
        --ci-aqua: #00a9a7;
        --ci-ink: #041620;
        --ci-ink-2: #0a222e;
        --ci-surface: #0e2029;
        --ci-border: #0e4a52;
        --ci-border-strong: #0d5f67;
        --ci-text: #cfe6df;
        --ci-muted: #7ea59d;
        --ci-gradient: linear-gradient(135deg, #58ebbf, #409b9b);
        --ci-gradient-hover: linear-gradient(135deg, #82ffe1, #58ebbf);
        --ci-glow: 0 0 20px -4px rgb(88 235 191 / 35%);
      }

      html,
      body {
        margin: 0;
        height: 100%;
        background:
          radial-gradient(1200px circle at 50% -20%, rgb(88 235 191 / 8%), transparent 55%),
          var(--ci-ink);
        font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      }

      #root {
        display: flex;
        flex-direction: column;
        height: 100vh;
      }

      /* --- CI-branded API key bar ------------------------------------------ */
      #apiKeyBar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 9px 16px;
        background: linear-gradient(180deg, var(--ci-ink-2), var(--ci-ink));
        border-bottom: 1px solid var(--ci-border);
        box-shadow: 0 1px 0 rgb(88 235 191 / 12%);
        color: var(--ci-text);
        font-size: 13px;
        flex: 0 0 auto;
      }
      #apiKeyBar .brand {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-right: 12px;
        margin-right: 2px;
        border-right: 1px solid var(--ci-border);
        white-space: nowrap;
      }
      #apiKeyBar .brand .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2.5px solid var(--ci-mint);
        box-shadow: var(--ci-glow);
      }
      #apiKeyBar .brand span {
        font-weight: 600;
        letter-spacing: 0.02em;
        color: #e8f6f1;
      }
      #apiKeyBar label {
        color: var(--ci-mint);
        font-weight: 600;
        white-space: nowrap;
      }
      #apiKeyBar input {
        flex: 1 1 auto;
        min-width: 120px;
        max-width: 460px;
        padding: 7px 11px;
        border: 1px solid var(--ci-border-strong);
        border-radius: 8px;
        background: var(--ci-surface);
        color: #e8f6f1;
        font-family: ui-monospace, 'SF Mono', Menlo, 'Fira Code', monospace;
        font-size: 12px;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      #apiKeyBar input::placeholder {
        color: var(--ci-muted);
      }
      #apiKeyBar input:focus {
        outline: none;
        border-color: var(--ci-mint);
        box-shadow: 0 0 0 3px rgb(88 235 191 / 18%);
      }
      #apiKeyBar button {
        padding: 7px 14px;
        border-radius: 8px;
        border: 1px solid transparent;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
      }
      #apiKeyBar button#apiKeySave {
        background: var(--ci-mint);
        background-image: var(--ci-gradient);
        color: var(--ci-ink);
        box-shadow: var(--ci-glow);
      }
      #apiKeyBar button#apiKeySave:hover {
        background-image: var(--ci-gradient-hover);
      }
      #apiKeyBar button#apiKeyClear {
        background: transparent;
        border-color: var(--ci-border-strong);
        color: var(--ci-text);
      }
      #apiKeyBar button#apiKeyClear:hover {
        border-color: var(--ci-mint);
        color: var(--ci-mint);
      }
      #apiKeyBar .status {
        white-space: nowrap;
        font-size: 12px;
        font-weight: 600;
      }
      #apiKeyBar .status.ok {
        color: var(--ci-mint);
      }
      #apiKeyBar .status.off {
        color: #e0a03c;
      }
      #apiKeyBar a {
        color: var(--ci-mint);
        text-decoration: none;
        white-space: nowrap;
      }
      #apiKeyBar a:hover {
        color: var(--ci-mint-hover);
        text-decoration: underline;
      }

      /* --- Brand GraphiQL's own chrome via its HSL-component variables ------
         GraphiQL 2.4.5 scopes its palette on "body:not(.graphiql-light)
         .graphiql-container" (dark, the default) and "body.graphiql-light …".
         We mirror those exact selectors so our declarations tie on specificity
         and win on source order (this style block follows the CDN stylesheet). */
      body:not(.graphiql-light) .graphiql-container,
      body:not(.graphiql-light) .CodeMirror-info,
      body:not(.graphiql-light) .CodeMirror-lint-tooltip,
      body:not(.graphiql-light) reach-portal {
        --color-primary: 162, 79%, 63%; /* CI mint  #58ebbf */
        --color-secondary: 180, 42%, 43%; /* CI teal  #409b9b */
        --color-tertiary: 179, 100%, 33%; /* CI aqua  #00a9a7 */
        --color-base: 202, 78%, 7%; /* CI ink   #041620 */
        --color-neutral: 174, 30%, 85%; /* mint-tinted foreground */
        --font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        --font-family-mono: ui-monospace, 'SF Mono', Menlo, 'Fira Code', monospace;
      }
      body.graphiql-light .graphiql-container,
      body.graphiql-light .CodeMirror-info,
      body.graphiql-light .CodeMirror-lint-tooltip,
      body.graphiql-light reach-portal {
        --color-primary: 180, 42%, 43%; /* CI teal — reads better on white */
        --color-secondary: 179, 100%, 33%; /* CI aqua */
        --color-tertiary: 188, 65%, 40%;
        --font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        --font-family-mono: ui-monospace, 'SF Mono', Menlo, 'Fira Code', monospace;
      }

      #graphiql {
        flex: 1 1 auto;
        min-height: 0;
      }
      #graphiql .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--ci-muted);
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <div id="root">
      <div id="apiKeyBar">
        <span class="brand"><span class="dot"></span><span>CI · GraphiQL</span></span>
        <label for="apiKeyInput">API key</label>
        <input
          id="apiKeyInput"
          type="password"
          placeholder="Paste an x-api-key…"
          autocomplete="off"
          spellcheck="false"
        />
        <button id="apiKeySave" type="button">Save</button>
        <button id="apiKeyClear" type="button">Clear</button>
        <span id="apiKeyStatus" class="status off">no key set</span>
        <a href="/settings/api-keys" target="_blank" rel="noopener noreferrer">Manage keys →</a>
      </div>
      <div id="graphiql"><div class="loading">Loading GraphiQL…</div></div>
    </div>

    <script>
      // Default the IDE to CI's dark ink theme (GraphiQL persists the user's own
      // choice under this key afterward, so a manual toggle still sticks).
      try {
        if (!localStorage.getItem('graphiql:theme')) {
          localStorage.setItem('graphiql:theme', 'dark');
        }
      } catch (e) {}
    </script>
    <script src="https://unpkg.com/react@18.2.0/umd/react.production.min.js"></script>
    <script src="https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/graphiql@${GRAPHIQL_VERSION}/graphiql.min.js"></script>
    <script>
      (function () {
        var STORAGE_KEY = 'ci-graphiql-api-key';

        var input = document.getElementById('apiKeyInput');
        var status = document.getElementById('apiKeyStatus');

        function getApiKey() {
          return localStorage.getItem(STORAGE_KEY) || '';
        }

        function renderStatus() {
          var key = getApiKey();
          if (key) {
            status.textContent = 'key active (' + key.slice(0, 6) + '…)';
            status.className = 'status ok';
          } else {
            status.textContent = 'no key set';
            status.className = 'status off';
          }
        }

        input.value = getApiKey();
        renderStatus();

        document.getElementById('apiKeySave').addEventListener('click', function () {
          var value = input.value.trim();
          if (value) {
            localStorage.setItem(STORAGE_KEY, value);
          } else {
            localStorage.removeItem(STORAGE_KEY);
          }
          renderStatus();
        });

        document.getElementById('apiKeyClear').addEventListener('click', function () {
          localStorage.removeItem(STORAGE_KEY);
          input.value = '';
          renderStatus();
        });

        // Read auth headers fresh on every request so saving a key takes effect
        // without reloading the page.
        var fetcher = function (graphQLParams) {
          var headers = { 'Content-Type': 'application/json' };
          var apiKey = getApiKey();
          if (apiKey) {
            headers['x-api-key'] = apiKey;
          }
          var bearer = localStorage.getItem('accessToken');
          if (bearer) {
            headers['Authorization'] = 'Bearer ' + bearer;
          }
          return fetch('/api/graphql', {
            method: 'POST',
            headers: headers,
            credentials: 'same-origin',
            body: JSON.stringify(graphQLParams),
          }).then(function (res) {
            return res.json();
          });
        };

        if (!window.GraphiQL) {
          document.getElementById('graphiql').textContent =
            'Failed to load GraphiQL from the CDN.';
          return;
        }

        var root = ReactDOM.createRoot(document.getElementById('graphiql'));
        root.render(
          React.createElement(window.GraphiQL, {
            fetcher: fetcher,
            defaultEditorToolsVisibility: true,
          }),
        );
      })();
    </script>
  </body>
</html>`;
