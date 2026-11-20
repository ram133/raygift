/**
 * RayGift Table — Cloudflare Worker (free tier)
 * Updates table/leaderboard.json in the ram133/raygift repo via GitHub Contents API.
 *
 * Required secrets (set via `wrangler secret put`):
 *   GITHUB_TOKEN   — fine-grained PAT with Contents: Read & Write on ram133/raygift
 *   GITHUB_OWNER   — "ram133"
 *   GITHUB_REPO    — "raygift"
 *   LEADERBOARD_PATH — "table/leaderboard.json"
 *
 * Optional:
 *   ALLOWED_ORIGIN — CORS origin (default "*")
 *
 * Concurrency safety:
 *   - Read file + SHA
 *   - Merge new score into top-10
 *   - PUT with the exact SHA (optimistic lock)
 *   - On 409 Conflict → retry up to MAX_RETRIES with fresh SHA
 */

const MAX_RETRIES = 5;
const TOP_N = 10;
const MIN_NAME = 2;
const MAX_NAME = 16;
const MAX_SCORE = 9999; // sanity ceiling for a 15 s tap game

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }), env);
    }

    if (request.method === "GET") {
      // Health / info
      return cors(json({ ok: true, service: "raygift-table", version: "1.0.0-draft" }), env);
    }

    if (request.method !== "POST") {
      return cors(json({ error: "Method not allowed" }, 405), env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return cors(json({ error: "Invalid JSON" }, 400), env);
    }

    const name = sanitizeName(body.name);
    const score = Number(body.score);

    if (!name || name.length < MIN_NAME) {
      return cors(json({ error: `Name must be ${MIN_NAME}–${MAX_NAME} characters` }, 400), env);
    }
    if (!Number.isFinite(score) || score < 1 || score > MAX_SCORE || !Number.isInteger(score)) {
      return cors(json({ error: "Score must be an integer between 1 and " + MAX_SCORE }, 400), env);
    }

    const owner = env.GITHUB_OWNER || "ram133";
    const repo = env.GITHUB_REPO || "raygift";
    const path = env.LEADERBOARD_PATH || "table/leaderboard.json";
    const token = env.GITHUB_TOKEN;

    if (!token) {
      return cors(json({ error: "Server misconfigured (missing GITHUB_TOKEN)" }, 500), env);
    }

    try {
      const result = await updateLeaderboard({ owner, repo, path, token, name, score });
      return cors(json({
        ok: true,
        message: result.inserted
          ? `Score ${score} accepted — you are #${result.rank}`
          : `Score ${score} received but did not enter top ${TOP_N}`,
        rank: result.rank,
        entries: result.entries
      }), env);
    } catch (err) {
      console.error("updateLeaderboard failed", err);
      return cors(json({ error: err.message || "Update failed" }, 502), env);
    }
  }
};

function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
}

function cors(response, env) {
  const origin = env.ALLOWED_ORIGIN || "*";
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Core update with optimistic concurrency.
 */
async function updateLeaderboard({ owner, repo, path, token, name, score }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 1. GET current file
      const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      const getRes = await fetch(getUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "raygift-table-worker"
        }
      });

      if (getRes.status === 404) {
        // First time — create empty board
        const initial = { updated: new Date().toISOString(), entries: [] };
        const createRes = await putFile({
          owner, repo, path, token,
          content: initial,
          sha: null,
          message: `table: init leaderboard`
        });
        if (!createRes.ok) {
          const t = await createRes.text();
          throw new Error(`Create failed: ${createRes.status} ${t}`);
        }
        // Fall through to re-read on next loop iteration
        continue;
      }

      if (!getRes.ok) {
        const t = await getRes.text();
        throw new Error(`GitHub GET failed: ${getRes.status} ${t}`);
      }

      const file = await getRes.json();
      const sha = file.sha;
      const raw = atob(file.content.replace(/\n/g, ""));
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { updated: new Date().toISOString(), entries: [] };
      }
      if (!Array.isArray(data.entries)) data.entries = [];

      // 2. Merge
      const entries = data.entries
        .map(e => ({ name: String(e.name || "").slice(0, MAX_NAME), score: Number(e.score) || 0 }))
        .filter(e => e.name && e.score > 0);

      entries.push({ name, score });
      entries.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      const top = entries.slice(0, TOP_N);

      // Determine rank of the submitted score (1-based, or null if not in top)
      let rank = null;
      for (let i = 0; i < top.length; i++) {
        if (top[i].name === name && top[i].score === score) {
          rank = i + 1;
          break;
        }
      }
      // If duplicate names exist, rank is the first matching; good enough for v1

      const newData = {
        updated: new Date().toISOString(),
        entries: top
      };

      // 3. PUT with SHA (optimistic lock)
      const putRes = await putFile({
        owner, repo, path, token,
        content: newData,
        sha,
        message: `table: ${name} scored ${score}`
      });

      if (putRes.status === 409) {
        // Conflict — another write won; retry
        lastError = new Error("Conflict (409) — retrying");
        await sleep(50 * attempt); // brief backoff
        continue;
      }

      if (!putRes.ok) {
        const t = await putRes.text();
        throw new Error(`GitHub PUT failed: ${putRes.status} ${t}`);
      }

      return {
        inserted: rank !== null,
        rank,
        entries: top
      };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await sleep(80 * attempt);
        continue;
      }
    }
  }
  throw lastError || new Error("Exhausted retries");
}

async function putFile({ owner, repo, path, token, content, sha, message }) {
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))),
    committer: { name: "RayGift Table", email: "table@raygift.local" }
  };
  if (sha) body.sha = sha;

  return fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "raygift-table-worker"
    },
    body: JSON.stringify(body)
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
