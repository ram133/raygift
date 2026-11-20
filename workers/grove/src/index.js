const PLOTS = 6;
const SEEDS = {
  sprout: { label: "Sun Sprout", growSeconds: 12, item: "Dewdrop Charm" },
  fern: { label: "Moon Fern", growSeconds: 20, item: "Lantern Leaf" },
  bloom: { label: "Star Bloom", growSeconds: 30, item: "Pollen Crown" }
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

const ADJ = ["Mossy", "Solar", "Breezy", "Quiet", "Amber", "Ferny", "Dewy", "Cinder"];
const NOUN = ["Sprout", "Finch", "Stone", "Brook", "Petal", "Acorn", "Reed", "Cloud"];

function genAnonIdentity() {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  const id = "g_" + rand[0].toString(36).slice(0, 8);
  const nick = `${ADJ[rand[1] % ADJ.length]} ${NOUN[(rand[1] >>> 8) % NOUN.length]} #${(rand[0] % 90) + 10}`;
  return { id, nickname: nick };
}

function defaultGardener(id, nickname, nowIso) {
  return {
    id,
    nickname,
    joinedAt: nowIso,
    updatedAt: nowIso,
    waters: 5,
    harvestCount: 0,
    xp: 0,
    items: [],
    plots: Array.from({ length: PLOTS }, (_, idx) => ({
      slot: idx,
      seed: null,
      plantedAt: null,
      waterCount: 0,
      lastWateredAt: null,
      readyAt: null,
      state: "empty"
    }))
  };
}

function computeStage(plot, nowMs) {
  if (!plot || !plot.seed || !plot.readyAt) return "empty";
  const readyMs = Date.parse(plot.readyAt);
  if (!Number.isFinite(readyMs)) return "growing";
  if (nowMs >= readyMs) return "ready";
  const plantedMs = Date.parse(plot.plantedAt || plot.readyAt);
  const span = Math.max(4000, readyMs - plantedMs);
  return nowMs - plantedMs >= span * 0.45 ? "sprouting" : "seedling";
}

function enrichGardener(g, nowMs) {
  const plots = (g.plots || []).map((p) => ({ ...p, stage: computeStage(p, nowMs) }));
  return { ...g, plots };
}

async function readState(env) {
  const owner = env.GH_OWNER || "ram133";
  const repo = env.GH_REPO || "raygift";
  const branch = env.GH_BRANCH || "main";
  const path = env.GH_GROVE_PATH || "data/grove-garden.json";
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "raygift-grove-worker",
      "Accept": "application/vnd.github+json"
    }
  });
  if (!res.ok) throw new Error(`GitHub GET failed (${res.status})`);
  const payload = await res.json();
  const decoded = atob(String(payload.content || "").replace(/\n/g, ""));
  const parsed = JSON.parse(decoded || '{"version":1,"gardeners":{}}');
  parsed.gardeners = parsed.gardeners && typeof parsed.gardeners === "object" ? parsed.gardeners : {};
  return { state: parsed, sha: payload.sha, owner, repo, path, branch };
}

async function writeStateWithRetry(env, mutator, commitMessage) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { state, sha, owner, repo, path, branch } = await readState(env);
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const result = mutator(state, nowIso, nowMs);
    if (result.error) {
      return { error: result.error, status: result.status || 400, gardener: result.gardener || null };
    }
    state.updatedAt = nowIso;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const body = {
      message: commitMessage,
      content: btoa(JSON.stringify(state, null, 2) + "\n"),
      sha,
      branch
    };
    const res = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "raygift-grove-worker",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      return { status: 200, gardener: enrichGardener(result.gardener, nowMs) };
    }
    if ((res.status === 409 || res.status === 422) && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 120 * attempt));
      continue;
    }
    const errTxt = await res.text();
    throw new Error(`GitHub PUT failed (${res.status}): ${errTxt}`);
  }
  throw new Error("Exceeded SHA conflict retry attempts");
}

function getOrCreateGardener(state, rawId, rawNick, nowIso) {
  const cleanId = typeof rawId === "string" && /^g_[a-z0-9]{4,24}$/i.test(rawId.trim()) ? rawId.trim() : null;
  if (cleanId && state.gardeners[cleanId]) {
    const g = state.gardeners[cleanId];
    if (!Array.isArray(g.plots) || g.plots.length !== PLOTS) {
      const fresh = defaultGardener(cleanId, g.nickname || genAnonIdentity().nickname, nowIso);
      state.gardeners[cleanId] = { ...fresh, ...g, plots: fresh.plots };
    }
    if (!Array.isArray(state.gardeners[cleanId].items)) state.gardeners[cleanId].items = [];
    if (typeof state.gardeners[cleanId].waters !== "number") state.gardeners[cleanId].waters = 5;
    return state.gardeners[cleanId];
  }
  const anon = genAnonIdentity();
  const id = cleanId || anon.id;
  const safeNick = typeof rawNick === "string" && rawNick.trim()
    ? rawNick.trim().replace(/[^\w\s#-]/g, "").slice(0, 20) || anon.nickname
    : anon.nickname;
  const created = defaultGardener(id, safeNick, nowIso);
  state.gardeners[id] = created;
  return created;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/state") {
        const id = String(url.searchParams.get("id") || "").trim();
        const { state } = await readState(env);
        const nowMs = Date.now();
        if (id && state.gardeners[id]) {
          return jsonRes({ gardener: enrichGardener(state.gardeners[id], nowMs) });
        }
        const summary = Object.values(state.gardeners).map((g) => ({
          id: g.id,
          nickname: g.nickname,
          harvestCount: g.harvestCount || 0,
          xp: g.xp || 0,
          itemsCount: Array.isArray(g.items) ? g.items.length : 0
        }));
        return jsonRes({ gardener: null, gardenCount: summary.length, gardeners: summary.slice(0, 20) });
      }

      if (request.method === "POST" && url.pathname === "/init") {
        const body = await request.json().catch(() => ({}));
        const out = await writeStateWithRetry(env, (state, nowIso, nowMs) => {
          const g = getOrCreateGardener(state, body.gardenerId, body.nickname, nowIso);
          g.updatedAt = nowIso;
          return { gardener: g };
        }, "feat(grove): initialize anonymous gardener");
        if (out.error) return jsonRes({ error: out.error }, out.status);
        return jsonRes({ gardener: out.gardener });
      }

      if (request.method === "POST" && url.pathname === "/plant") {
        const body = await request.json().catch(() => ({}));
        const slot = Number(body.slot);
        const seedKey = String(body.seed || "").trim().toLowerCase();
        if (!Number.isInteger(slot) || slot < 0 || slot >= PLOTS || !SEEDS[seedKey]) {
          return jsonRes({ error: "Invalid plot slot or seed type" }, 400);
        }
        const out = await writeStateWithRetry(env, (state, nowIso, nowMs) => {
          const g = getOrCreateGardener(state, body.gardenerId, body.nickname, nowIso);
          const plot = g.plots[slot];
          if (plot.seed !== null) {
            return { error: "Plot already has a plant", status: 409, gardener: enrichGardener(g, nowMs) };
          }
          const seedMeta = SEEDS[seedKey];
          plot.seed = seedKey;
          plot.plantedAt = nowIso;
          plot.lastWateredAt = null;
          plot.waterCount = 0;
          plot.readyAt = new Date(nowMs + seedMeta.growSeconds * 1000).toISOString();
          plot.state = "growing";
          g.xp = (g.xp || 0) + 5;
          g.updatedAt = nowIso;
          return { gardener: g };
        }, `chore(grove): plant ${seedKey} in slot ${slot + 1}`);
        if (out.error) return jsonRes({ error: out.error, gardener: out.gardener }, out.status);
        return jsonRes({ gardener: out.gardener });
      }

      if (request.method === "POST" && url.pathname === "/water") {
        const body = await request.json().catch(() => ({}));
        const slot = Number(body.slot);
        if (!Number.isInteger(slot) || slot < 0 || slot >= PLOTS) {
          return jsonRes({ error: "Invalid plot slot" }, 400);
        }
        const out = await writeStateWithRetry(env, (state, nowIso, nowMs) => {
          const g = getOrCreateGardener(state, body.gardenerId, body.nickname, nowIso);
          const plot = g.plots[slot];
          if (!plot.seed) {
            return { error: "Plot is empty; plant a seed first", status: 409, gardener: enrichGardener(g, nowMs) };
          }
          if ((g.waters || 0) <= 0) {
            return { error: "No watering charges left", status: 409, gardener: enrichGardener(g, nowMs) };
          }
          const currentReadyMs = Date.parse(plot.readyAt || nowIso);
          const remainingMs = Math.max(0, currentReadyMs - nowMs);
          const speedBoostMs = Math.max(3000, Math.floor(remainingMs * 0.35));
          plot.readyAt = new Date(Math.max(nowMs, currentReadyMs - speedBoostMs)).toISOString();
          plot.waterCount = (plot.waterCount || 0) + 1;
          plot.lastWateredAt = nowIso;
          g.waters = (g.waters || 0) - 1;
          g.xp = (g.xp || 0) + 10;
          g.updatedAt = nowIso;
          return { gardener: g };
        }, `chore(grove): water slot ${slot + 1}`);
        if (out.error) return jsonRes({ error: out.error, gardener: out.gardener }, out.status);
        return jsonRes({ gardener: out.gardener });
      }

      if (request.method === "POST" && url.pathname === "/harvest") {
        const body = await request.json().catch(() => ({}));
        const slot = Number(body.slot);
        if (!Number.isInteger(slot) || slot < 0 || slot >= PLOTS) {
          return jsonRes({ error: "Invalid plot slot" }, 400);
        }
        const out = await writeStateWithRetry(env, (state, nowIso, nowMs) => {
          const g = getOrCreateGardener(state, body.gardenerId, body.nickname, nowIso);
          const plot = g.plots[slot];
          if (!plot.seed) {
            return { error: "Nothing to harvest in empty plot", status: 409, gardener: enrichGardener(g, nowMs) };
          }
          const readyMs = Date.parse(plot.readyAt || "");
          if (!Number.isFinite(readyMs) || nowMs < readyMs) {
            return { error: "Plant is still growing", status: 409, gardener: enrichGardener(g, nowMs) };
          }
          const meta = SEEDS[plot.seed] || SEEDS.sprout;
          const existingIdx = g.items.findIndex((it) => it.name === meta.item);
          if (existingIdx >= 0) {
            g.items[existingIdx].count = (g.items[existingIdx].count || 1) + 1;
            g.items[existingIdx].lastEarnedAt = nowIso;
          } else {
            g.items.push({
              id: plot.seed + "_" + meta.item.toLowerCase().replace(/\s+/g, "_"),
              name: meta.item,
              seed: plot.seed,
              count: 1,
              firstEarnedAt: nowIso,
              lastEarnedAt: nowIso
            });
          }
          g.harvestCount = (g.harvestCount || 0) + 1;
          g.xp = (g.xp || 0) + 25;
          g.waters = Math.min(10, (g.waters || 0) + 2);
          plot.seed = null;
          plot.plantedAt = null;
          plot.waterCount = 0;
          plot.lastWateredAt = null;
          plot.readyAt = null;
          plot.state = "empty";
          g.updatedAt = nowIso;
          return { gardener: g };
        }, `feat(grove): harvest slot ${slot + 1}`);
        if (out.error) return jsonRes({ error: out.error, gardener: out.gardener }, out.status);
        return jsonRes({ gardener: out.gardener });
      }

      return jsonRes({ error: "Not found" }, 404);
    } catch (err) {
      return jsonRes({ error: err.message }, 500);
    }
  }
};
