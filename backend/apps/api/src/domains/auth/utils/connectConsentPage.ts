/**
 * Server-rendered HTML for the app-connect consent step.
 *
 * This page is shown on ci-memory's own origin (so the session cookie is
 * in-scope) after the user has signed in. It explains what access the app is
 * requesting and lets the user Allow (mint a scoped key and return to CI-Hub)
 * or say Not now (bounce back to the originating app's interstitial).
 *
 * NO client JavaScript. The page is fronted by the CI-Server nginx gateway,
 * which stamps its own `script-src 'self'` CSP on every response; the browser
 * enforces the intersection of that and this route's CSP, so an inline
 * `<script>` — nonce'd or not — can never run here. Both actions are therefore
 * plain HTML: Allow is a same-origin `<form method="POST">` (allowed by
 * `form-action 'self'`) that the server answers with a 302 to CI-Hub; Not now
 * is an `<a>` to the CI-Hub return URL carrying `error=access_denied` (a
 * top-level link navigation, not restricted by `form-action`). This mirrors the
 * agent-app interstitials (CI-OpenClaw / CI-Hermes), which are also pure
 * form/link markup for the same reason.
 *
 * Kept as a typed template module (rather than a separate .html asset) so the
 * markup, the context-specific escaping it depends on, and its only inputs stay
 * co-located and bundle automatically — no runtime template loading / dist-asset
 * copying. The one large static block (styles) lives in the constant below so
 * the page skeleton in `renderConnectConsentPage` reads clearly.
 *
 * NOTE (i18n): CI-Server's API has no i18n runtime, so these strings are
 * English-only. If richer/localised consent UX is needed, this page should move
 * into the CI-Server SPA (which has i18n) with the backend exposing the consent
 * metadata as JSON — tracked as a follow-up.
 */

import { MEMORY_LOGO_DATA_URI } from './connectMemoryLogo';

export interface ConnectConsentParams {
  /** The requesting app's URN (identity, always present). */
  appUrn: string;
  /** Human-friendly app name for display; falls back to the URN. */
  appName?: string;
  /** Opaque CI-Hub state nonce, echoed back on the redirect. */
  state: string;
  /** Allowlisted CI-Hub return URL (validated before rendering). */
  returnUrl: string;
  /** Pre-built CI-Hub URL to send the user to on "Not now" (return + error). */
  denyUrl: string;
  /** CSRF token to echo in the form's hidden field; matches the csrf cookie. */
  csrfToken: string;
  /** The scopes the key will be minted with (from `scopesForApp`). Drives the
   *  capability list shown to the user so consent reflects the actual grant. An
   *  empty array means full access. */
  scopes: string[];
  /** Email of the signed-in Companion Memory user, shown so the account the app
   *  is being granted access to is never ambiguous. */
  userEmail?: string;
  /** Per-request CSP nonce; stamped on the inline <style> so the page's own
   *  styles apply while any injected inline style (no nonce) is blocked. */
  nonce: string;
  /** True when this render is the one-shot retry after a CSRF failure on
   *  /approve; echoed as a hidden field so a second consecutive failure renders
   *  a hard error instead of redirect-looping. */
  csrfRetry?: boolean;
}

/** Escape a string for safe interpolation into HTML text/attribute context. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Human-readable capabilities the minted key will grant, from its scopes. Kept
 * in step with `scopesForApp` (the same scopes are what the key is minted with),
 * so what the user consents to is exactly what the app receives. An empty scope
 * set means a full-access key, disclosed as such rather than mislabeled.
 */
function capabilityLinesForScopes(scopes: string[]): string[] {
  if (scopes.length === 0) {
    return ['Full access to your Companion data — memory, files, imports, and knowledge graph'];
  }

  const KNOWN: Record<string, string> = {
    memory: 'Read and write your long-term memory',
    intents: 'Read your intent catalog',
    mcp: 'Use your memory tools (MCP)',
  };

  return scopes.map((scope) => KNOWN[scope] ?? `Access "${scope}"`);
}

/**
 * Static page styles (no request-derived input). Mirrors the agent-app connect
 * interstitials' aesthetic: navy background, elevated card, teal brand-gradient
 * primary pill, with a light-scheme fallback. The Companion Memory logo sits on
 * a dark rounded tile (it has an opaque background). Buttons stay side-by-side
 * (`.actions{display:flex}`), the layout this consent page has always used.
 */
const CONSENT_STYLES = /* css */ `
    :root{color-scheme:dark;--bg:#041620;--card:#0c323c;--border:#073038;--fg:#e8f2f4;--fg-dim:#a3babf;--brand-grad:linear-gradient(135deg,#0e766a 0%,#064741 100%);--on-accent:#f0fdf4;--shadow:0 6px 24px rgba(4,22,32,.22)}
    @media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f3faf7;--card:#f0f9f5;--border:#dfece6;--fg:#0a222e;--fg-dim:#3a524b;--shadow:0 6px 24px rgba(4,22,32,.12)}}
    *{box-sizing:border-box}
    body{font-family:"Manrope",system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);padding:40px 20px}
    .card{width:100%;max-width:440px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:36px 28px;box-shadow:var(--shadow)}
    .logo-wrap{display:flex;justify-content:center;margin:0 auto 22px}
    .cm{width:56px;height:56px;object-fit:contain;border-radius:14px;background:#000;box-shadow:0 2px 10px rgba(0,0,0,.28)}
    h1{font-size:20px;font-weight:700;margin:0 0 8px}
    p{line-height:1.5;color:var(--fg-dim);font-size:14px;margin:0 0 24px}
    .app{color:var(--fg);font-weight:600}
    .lead{margin:0 0 14px}
    .caps{list-style:none;margin:0 0 20px;padding:0;text-align:left;display:flex;flex-direction:column;gap:8px}
    .caps li{position:relative;padding:10px 12px 10px 34px;background:rgba(7,157,153,.08);border:1px solid var(--border);border-radius:8px;color:var(--fg);font-size:13px;line-height:1.4}
    .caps li::before{content:"";position:absolute;left:13px;top:15px;width:9px;height:9px;border-radius:3px;background:var(--brand-grad)}
    .disconnect-note{font-size:12px;margin:0 0 24px}
    .signed-in{font-size:12px;color:var(--fg-dim);margin:-8px 0 20px}
    .signed-in strong{color:var(--fg);font-weight:600}
    /* Two equal-width columns so "Not now" and "Allow" match exactly. A flex
       layout sizes each item to its text (flex-basis resolves to content here),
       which made "Not now" wider than "Allow"; grid 1fr/1fr ignores content. */
    .actions{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .actions form{margin:0}
    .btn{display:block;width:100%;padding:12px 20px;border-radius:999px;border:0;font-size:15px;font-weight:600;line-height:1.2;cursor:pointer;text-align:center;text-decoration:none;font-family:inherit}
    .primary{background:var(--brand-grad);color:var(--on-accent)}
    .primary:hover{filter:brightness(1.06)}
    .secondary{background:transparent;color:var(--fg-dim);border:1px solid var(--border)}
    .secondary:hover{color:var(--fg);border-color:var(--fg-dim)}`;

/**
 * Render the consent page. The request-derived values (`appName`, `state`,
 * `returnUrl`, `denyUrl`, `csrfToken`) are HTML-escaped for their contexts to
 * prevent injection; `returnUrl`/`denyUrl` have already been origin-allowlisted
 * by the caller.
 */
export function renderConnectConsentPage(params: ConnectConsentParams): string {
  // Normalise once: the trimmed name drives both the heading and the hidden
  // app_name field that carries it through the CSRF self-heal round-trip.
  const trimmedAppName = params.appName?.trim();
  const displayName = escapeHtml(trimmedAppName || params.appUrn);
  const appUrn = escapeHtml(params.appUrn);
  const state = escapeHtml(params.state);
  const returnUrl = escapeHtml(params.returnUrl);
  const denyUrl = escapeHtml(params.denyUrl);
  const csrfToken = escapeHtml(params.csrfToken);
  const capabilityItems = capabilityLinesForScopes(params.scopes)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('\n      ');
  // The email is wrapped in Cloudflare `email_off` markers at the render site:
  // the zone has Email Address Obfuscation on, which would otherwise rewrite the
  // address into a `/cdn-cgi/l/email-protection` link + a decoder script — and
  // that script is blocked by this page's nonce-only CSP, leaving a dead
  // "[email protected]" link. `email_off` opts the address out at the edge.
  const signedInEmail = params.userEmail?.trim() ? escapeHtml(params.userEmail.trim()) : '';

  return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect to Companion Memory</title>
  <style nonce="${params.nonce}">${CONSENT_STYLES}</style>
</head>
<body>
  <main class="card">
    <div class="logo-wrap">
      <img class="cm" src="${MEMORY_LOGO_DATA_URI}" alt="Companion Memory" width="56" height="56" />
    </div>
    <h1>Connect to Companion Memory</h1>
    <p class="lead"><span class="app">${displayName}</span> is requesting access to your
      Companion Memory, so it can remember your context across sessions. If you allow, it will
      be able to:</p>
    <ul class="caps">
      ${capabilityItems}
    </ul>
    <p class="disconnect-note">You can disconnect it at any time.</p>
    ${signedInEmail ? `<p class="signed-in">Signed in as <strong><!--email_off-->${signedInEmail}<!--/email_off--></strong></p>` : ''}
    <div class="actions">
      <a class="btn secondary" href="${denyUrl}">Not now</a>
      <form method="POST" action="/api/connect/approve">
        <input type="hidden" name="app" value="${appUrn}" />
        <input type="hidden" name="state" value="${state}" />
        <input type="hidden" name="return" value="${returnUrl}" />
        <input type="hidden" name="csrf" value="${csrfToken}" />${
          trimmedAppName
            ? `
        <input type="hidden" name="app_name" value="${escapeHtml(trimmedAppName)}" />`
            : ''
        }${
          params.csrfRetry
            ? `
        <input type="hidden" name="csrf_retry" value="1" />`
            : ''
        }
        <button class="btn primary" type="submit">Allow</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}

/**
 * Render the page that carries the browser back to CI-Hub after the Allow POST.
 *
 * Why not just `res.redirect(hubUrl)`? The nginx gateway stamps `form-action
 * 'self'` on every response, and Chrome enforces form-action on the *redirect*
 * of a form submission — so a 302 from the Allow form to the cross-origin CI-Hub
 * URL is silently refused (the POST completes, then nothing happens). A
 * `<meta http-equiv="refresh">` is a top-level navigation, NOT a form submission,
 * so form-action does not apply — the same navigation kind the "Not now" <a> link
 * uses, which reaches CI-Hub fine. The dark background matches the consent page
 * so there's no white flash on the hop.
 *
 * The "Continue" <a> is the manual escape hatch for the browsers where the
 * meta refresh never fires (Firefox's blockautorefresh setting,
 * kiosk/enterprise policies, some privacy extensions) — without it those users
 * would be stranded on an endless spinner, and this page cannot script its way
 * out (nginx stamps `script-src 'self'`, so no inline JS). Since the refresh
 * normally wins instantly, the link stays invisible for a few seconds
 * (CSS-only reveal) so the ordinary hop shows just the spinner.
 *
 * The copy deliberately differs from the Hub's /memory-connect/finishing
 * interstitial ("Applying your memory connection"): by the time this page
 * renders, access IS granted — all that's left is carrying the browser back to
 * where the connect flow started, so it says exactly that.
 *
 * `hubUrl` is an already-origin-allowlisted CI-Hub URL; it is HTML-escaped here
 * for the meta content and href attributes.
 */
export function renderConnectRedirectPage(hubUrl: string): string {
  const url = escapeHtml(hubUrl);

  return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0; url=${url}" />
  <title>Taking you back…</title>
  <style>
    :root { color-scheme: dark light; }
    * { box-sizing: border-box; }
    body { font-family: "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif;
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #041620; color: #e8f2f4; padding: 40px 20px; }
    @media (prefers-color-scheme: light) { body { background: #f3faf7; color: #0a222e; } }
    .wrap { display: flex; flex-direction: column; align-items: center; gap: 16px; text-align: center; }
    .spinner { width: 34px; height: 34px; border-radius: 50%;
      border: 3px solid rgba(163, 186, 191, .25); border-top-color: #0a6358;
      animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .msg { margin: 0; font-size: 15px; font-weight: 600; }
    /* Hidden until the meta refresh has clearly not fired; the delay is the
       only "detection" available without JS. */
    .link { font-size: 13px; color: #9bb2b7; text-decoration: underline; text-underline-offset: 3px;
      opacity: 0; animation: reveal .4s ease 4s forwards; }
    .link:hover { color: inherit; }
    @keyframes reveal { to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      .spinner { animation: none; }
      /* No animations ⇒ no timed reveal — keep the fallback link visible. */
      .link { animation: none; opacity: 1; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="spinner" aria-hidden="true"></div>
    <p class="msg">Access granted — taking you back…</p>
    <a class="link" href="${url}">Continue</a>
  </main>
</body>
</html>`;
}

/**
 * Render a minimal error page for connect failures that cannot proceed to the
 * consent step (e.g. a missing or disallowed return URL).
 */
export function renderConnectErrorPage(message: string): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Connect error</title>
  <style>body{font-family:system-ui,sans-serif;margin:3rem;color:#333}</style></head>
<body><h1>Unable to connect</h1><p>${escapeHtml(message)}</p></body>
</html>`;
}
