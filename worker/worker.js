// Cloudflare Worker: the "middleman" that lets your dashboard add and remove stocks, and refresh the data.
// Add/remove edit tickers.txt in your GitHub repository, which starts your automation.
// Refresh starts the "Update dashboard" workflow directly (at most once every 10 minutes).
//
// Settings to create in Cloudflare (Worker > Settings > Variables and Secrets):
//   GITHUB_TOKEN  (type: Secret)  fine-grained token for this one repository:
//                                 Contents: Read and write, and Actions: Read and write
//   OWNER         your GitHub username
//   REPO          your repository name
//   SITE_ORIGIN   your website's origin, e.g. https://yourname.github.io  (no slash at the end, no folder)
//   MAX_TICKERS   optional, default 40
//   WORKFLOW_FILE optional, default update.yml
//   BRANCH        optional, default main

const TICKER = /^[A-Z0-9][A-Z0-9.\-=^]{0,11}$/;
const tickerOf = (line) => line.split('#')[0].trim().toUpperCase();
const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

function fromB64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function toB64(text) {
  let bin = '';
  new TextEncoder().encode(text).forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.SITE_ORIGIN || '',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return reply({ ok: false, error: 'Use POST.' }, 405);
    if (!env.GITHUB_TOKEN || !env.OWNER || !env.REPO || !env.SITE_ORIGIN) {
      return reply({ ok: false, error: 'The service is not fully set up yet (a Cloudflare setting is missing).' }, 500);
    }
    if (request.headers.get('Origin') !== env.SITE_ORIGIN) {
      return reply({ ok: false, error: 'This website is not allowed to use the service.' }, 403);
    }

    let body;
    try { body = JSON.parse(await request.text()); } catch (e) { return reply({ ok: false, error: 'Bad request.' }, 400); }
    const action = body && body.action;
    if (action !== 'add' && action !== 'remove' && action !== 'refresh') return reply({ ok: false, error: 'Unknown action.' }, 400);

    const repoUrl = `https://api.github.com/repos/${encodeURIComponent(env.OWNER)}/${encodeURIComponent(env.REPO)}`;
    const headers = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'stock-dashboard-worker',
    };

    // ---- refresh: start the update workflow, unless one ran or is running very recently ----
    if (action === 'refresh') {
      const wf = encodeURIComponent(env.WORKFLOW_FILE || 'update.yml');
      const runs = await fetch(`${repoUrl}/actions/workflows/${wf}/runs?per_page=1`, { headers });
      if (!runs.ok) return reply({ ok: false, error: `Could not check the update status on GitHub (status ${runs.status}). The token may need the Actions permission.` }, 502);
      const last = ((await runs.json()).workflow_runs || [])[0];
      if (last && last.status !== 'completed') return reply({ ok: true, result: 'running' });
      if (last && Date.now() - new Date(last.created_at).getTime() < REFRESH_COOLDOWN_MS) {
        return reply({ ok: false, error: 'The data was refreshed a few minutes ago. Please try again in about 10 minutes.' }, 429);
      }
      const go = await fetch(`${repoUrl}/actions/workflows/${wf}/dispatches`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: env.BRANCH || 'main' }),
      });
      if (go.ok) return reply({ ok: true, result: 'started' });
      return reply({ ok: false, error: `GitHub would not start the update (status ${go.status}). The token may need the Actions permission.` }, 502);
    }

    const ticker = String((body && body.ticker) || '').trim().toUpperCase();
    if (!TICKER.test(ticker)) return reply({ ok: false, error: 'That does not look like a ticker symbol. Use letters and numbers, like AMD or BRK-B.' }, 400);

    const max = parseInt(env.MAX_TICKERS, 10) || 40;
    const url = `${repoUrl}/contents/tickers.txt`;

    for (let attempt = 0; attempt < 3; attempt++) {
      const get = await fetch(url, { headers });
      if (!get.ok) return reply({ ok: false, error: `Could not read the watchlist from GitHub (status ${get.status}). Check the Cloudflare settings.` }, 502);
      const file = await get.json();
      const text = fromB64(file.content);
      const have = text.split('\n').map(tickerOf).filter(Boolean);

      let next, result;
      if (action === 'add') {
        if (have.includes(ticker)) return reply({ ok: true, result: 'exists' });
        if (have.length >= max) return reply({ ok: false, error: `The watchlist is full (${max} stocks). Remove one first.` }, 409);
        next = text.replace(/\s*$/, '') + '\n' + ticker + '\n';
        result = 'added';
      } else {
        const lines = text.split('\n');
        const kept = lines.filter((l) => tickerOf(l) !== ticker);
        if (kept.length === lines.length) return reply({ ok: true, result: 'notfound' });
        next = kept.join('\n');
        result = 'removed';
      }

      const put = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `${action === 'add' ? 'Add' : 'Remove'} ${ticker} (from website)`, content: toB64(next), sha: file.sha }),
      });
      if (put.ok) return reply({ ok: true, result });
      if (put.status === 409 || put.status === 422) continue; // the file changed while we worked: read it again and retry
      return reply({ ok: false, error: `GitHub refused the change (status ${put.status}). Check the token's permissions.` }, 502);
    }
    return reply({ ok: false, error: 'The watchlist was busy. Please try again.' }, 503);
  },
};
