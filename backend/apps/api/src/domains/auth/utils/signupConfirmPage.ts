/**
 * Server-rendered "create your account?" confirmation, shown after a first-time
 * OIDC sign-in when no Companion Memory account exists for the Portal identity
 * yet. Previously the account was auto-provisioned silently; this page makes
 * account creation an explicit choice.
 *
 * Like the app-connect consent page, it runs NO JavaScript — the CI-Server nginx
 * gateway stamps `script-src 'self'` on every response, so an inline script can
 * never run. "Create account" is a same-origin `<form>` POST (allowed by
 * `form-action 'self'`); "Cancel" is a link. The signed signup-intent cookie
 * (not any field on this page) is what authorises the create, so a forged POST
 * can't create an account for an arbitrary email.
 */

export interface SignupConfirmParams {
  /** OIDC-verified email of the identity signing in (display only). */
  email: string;
  /** CSRF token echoed in the form's hidden field; matches the csrf cookie. */
  csrfToken: string;
  /** Where "Cancel" goes (same-origin relative path), e.g. '/login'. */
  cancelUrl: string;
  /** Per-request CSP nonce for the inline <style>. */
  nonce: string;
  /** True when this render is the one-shot retry after a CSRF failure; echoed
   *  as a hidden field so a second consecutive failure exits to /login instead
   *  of looping. */
  csrfRetry?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = /* css */ `
    :root{color-scheme:dark;--bg:#041620;--card:#0c323c;--border:#073038;--fg:#e8f2f4;--fg-dim:#a3babf;--brand-grad:linear-gradient(135deg,#0e766a 0%,#064741 100%);--on-accent:#f0fdf4;--shadow:0 6px 24px rgba(4,22,32,.22)}
    @media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f3faf7;--card:#f0f9f5;--border:#dfece6;--fg:#0a222e;--fg-dim:#3a524b;--shadow:0 6px 24px rgba(4,22,32,.12)}}
    *{box-sizing:border-box}
    body{font-family:"Manrope",system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);padding:40px 20px}
    .card{width:100%;max-width:440px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:36px 28px;box-shadow:var(--shadow)}
    h1{font-size:20px;font-weight:700;margin:0 0 8px}
    p{line-height:1.5;color:var(--fg-dim);font-size:14px;margin:0 0 24px}
    .email{color:var(--fg);font-weight:600}
    .actions{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .actions form{margin:0}
    .btn{display:block;width:100%;padding:12px 20px;border-radius:999px;border:0;font-size:15px;font-weight:600;line-height:1.2;cursor:pointer;text-align:center;text-decoration:none;font-family:inherit}
    .primary{background:var(--brand-grad);color:var(--on-accent)}
    .primary:hover{filter:brightness(1.06)}
    .secondary{background:transparent;color:var(--fg-dim);border:1px solid var(--border)}
    .secondary:hover{color:var(--fg);border-color:var(--fg-dim)}`;

export function renderSignupConfirmPage(params: SignupConfirmParams): string {
  const email = escapeHtml(params.email);
  const csrfToken = escapeHtml(params.csrfToken);
  const cancelUrl = escapeHtml(params.cancelUrl);

  return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Create your Companion Memory account</title>
  <style nonce="${params.nonce}">${STYLES}</style>
</head>
<body>
  <main class="card">
    <h1>Create your Companion Memory account?</h1>
    <p>You signed in with Companion Intelligence as <span class="email"><!--email_off-->${email}<!--/email_off--></span>.
      No Companion Memory account exists here yet — create one to continue.</p>
    <div class="actions">
      <a class="btn secondary" href="${cancelUrl}">Cancel</a>
      <form method="POST" action="/api/authenticate/oidc/confirm-account">
        <input type="hidden" name="csrf" value="${csrfToken}" />${
          params.csrfRetry
            ? `
        <input type="hidden" name="csrf_retry" value="1" />`
            : ''
        }
        <button class="btn primary" type="submit">Create account</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}
