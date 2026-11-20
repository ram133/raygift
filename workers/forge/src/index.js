const PARTS = ["ember_core", "sun_alloy", "tide_shard"];
const PART_LABELS = {
  ember_core: "Ember Core",
  sun_alloy: "Sun Alloy",
  tide_shard: "Tide Shard"
};
const TIERS = ["Scrap", "Tempered", "Relic", "Mythic"];
const THEMES = ["obsidian", "ember", "emerald", "cobalt"];

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

const ADJ = ["Iron", "Copper", "Gilded", "Spark", "Basalt", "Solar", "Drift", "Astral"];
const NOUN = ["Anvil", "Hammer", "Tongs", "Bellows", "Cinder", "Prism", "Rivets", "Kiln"];

function genAnonIdentity() {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  const id = "f_" + rand[0].toString(36).slice(0, 8);
  const nick = `${ADJ[rand[1] % ADJ.length]} ${NOUN[(rand[1] >>> 8) % NOUN.length]} #${(rand[0] % 90) + 10}`;
  return { id, nickname: nick };
}

function defaultCrafter(id, nickname, nowIso) {
  return {
    id,
    nickname,
    joinedAt: nowIso,
    updatedAt: nowIso,
    claimCharges: 3,
    lastClaimAt: null,
    xp: 0,
    parts: { ember_core: 1, sun_alloy: 1, tide_shard: 0 },
    collectibles: [
      { id: "col_1", name: "Ember Core", partKey: "ember_core", tierIndex: 0, tierName: "Scrap", count: 1 }
    ],
    display: {
      title: "Starter Bench",
      theme: "obsidian",
      spotlightItemId: "col_1",
      bio: "Forging free parts on RayGift."
    }
  };
}

function syncTierNames(c) {
  c.collectibles = (c.collectibles || []).map((item) => {
    const idx = Math.max(0, Math.min(TIERS.length - 1, Number(item.tierIndex || 0)));
    return { ...item, tierIndex: idx, tierName: TIERS[idx] };
  });
}

async function readState(env) {
  const owner = env.GH_OWNER || "ram133";
  const repo = env.GH_REPO || "raygift";
  const branch = env.GH_BRANCH || "main";
  const path = env.GH_FORGE_PATH || "data/forge-state.json";
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "raygift-forge-worker",
      "Accept": "application/vnd.github+json"
    }
  });
  if (!res.ok) throw new Error(`GitHub GET failed (${res.status})`);
  const payload = await res.json();
  const decoded = atob(String(payload.content || "").replace(/\n/g, ""));
  const parsed = JSON.parse(decoded || '{"version":1,"crafters":{}}');
  parsed.crafters = parsed.crafters && typeof parsed.crafters === "object" ? parsed.crafters : {};
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
      return { error: result.error, status: result.status || 400, crafter: result.crafter || null };
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
        "User-Agent": "raygift-forge-worker",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      return { status: 200, crafter: result.crafter };
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

function getOrCreateCrafter(state, rawId, rawNick, nowIso) {
  const cleanId = typeof rawId === "string" && /^f_[a-z0-9]{4,24}$/i.test(rawId.trim()) ? rawId.trim() : null;
  if (cleanId && state.crafters[cleanId]) {
    const c = state.crafters[cleanId];
    c.parts = c.parts && typeof c.parts === "object" ? c.parts : { ember_core: 1, sun_alloy: 1, tide_shard: 0 };
    for (const k of PARTS) {
      if (typeof c.parts[k] !== "number") c.parts[k] = 0;
    }
    c.collectibles = Array.isArray(c.collectibles) ? c.collectibles : [];
    c.display = c.display && typeof c.display === "object"
      ? c.display
      : { title: "Starter Bench", theme: "obsidian", spotlightItemId: c.collectibles[0]?.id || null, bio: "Forging free parts on RayGift." };
    if (typeof c.claimCharges !== "number") c.claimCharges = 3;
    syncTierNames(c);
    return c;
  }
  const anon = genAnonIdentity();
  const id = cleanId || anon.id;
  const safeNick = typeof rawNick === "string" && rawNick.trim()
    ? rawNick.trim().replace(/[^\w\s#-]/g, "").slice(0, 20) || anon.nickname
    : anon.nickname;
  const created = defaultCrafter(id, safeNick, nowIso);
  state.crafters[id] = created;
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
        if (id && state.crafters[id]) {
          syncTierNames(state.crafters[id]);
          return jsonRes({ crafter: state.crafters[id] });
        }
        const showcase = Object.values(state.crafters).slice(0, 20).map((c) => {
          syncTierNames(c);
          return {
            id: c.id,
            nickname: c.nickname,
            xp: c.xp || 0,
            display: c.display,
            collectibles: c.collectibles
          };
        });
        return jsonRes({ crafter: null, showcase });
      }

      if (request.method === "POST" && url.pathname === "/init") {
        const body = await request.json().catch(() => ({}));
        const out = await writeStateWithRetry(env, (state, nowIso) => {
          const c = getOrCreateCrafter(state, body.crafterId, body.nickname, nowIso);
          c.updatedAt = nowIso;
          return { crafter: c };
        }, "feat(forge): initialize anonymous crafter");
        if (out.error) return jsonRes({ error: out.error }, out.status);
        return jsonRes({ crafter: out.crafter });
      }

      if (request.method === "POST" && url.pathname === "/claim") {
        const body = await request.json().catch(() => ({}));
        const out = await writeStateWithRetry(env, (state, nowIso, nowMs) => {
          const c = getOrCreateCrafter(state, body.crafterId, body.nickname, nowIso);
          if (c.lastClaimAt && nowMs - Date.parse(c.lastClaimAt) >= 3600 * 1000) {
            c.claimCharges = Math.max(c.claimCharges || 0, 3);
          }
          if ((c.claimCharges || 0) <= 0) {
            return { error: "No free claim charges left right now", status: 409, crafter: c };
          }
          const pickedKey = PARTS.includes(body.partKey)
            ? body.partKey
            : PARTS[(c.xp || 0 + (c.claimCharges || 0)) % PARTS.length];
          const amount = 2;
          c.parts[pickedKey] = (c.parts[pickedKey] || 0) + amount;
          c.claimCharges = Math.max(0, (c.claimCharges || 0) - 1);
          c.lastClaimAt = nowIso;
          c.xp = (c.xp || 0) + 10;
          c.updatedAt = nowIso;

          const baseName = PART_LABELS[pickedKey];
          const existing = c.collectibles.find((x) => x.partKey === pickedKey && Number(x.tierIndex || 0) === 0);
          if (existing) {
            existing.count = (existing.count || 1) + 1;
          } else {
            const newId = `col_${pickedKey}_0_${c.collectibles.length + 1}`;
            c.collectibles.push({
              id: newId,
              name: baseName,
              partKey: pickedKey,
              tierIndex: 0,
              tierName: TIERS[0],
              count: 1
            });
            if (!c.display.spotlightItemId) c.display.spotlightItemId = newId;
          }
          syncTierNames(c);
          return { crafter: c };
        }, "feat(forge): claim free crafting parts");
        if (out.error) return jsonRes({ error: out.error, crafter: out.crafter }, out.status);
        return jsonRes({ crafter: out.crafter });
      }

      if (request.method === "POST" && url.pathname === "/combine") {
        const body = await request.json().catch(() => ({}));
        const itemId = String(body.itemId || "").trim();
        const out = await writeStateWithRetry(env, (state, nowIso) => {
          const c = getOrCreateCrafter(state, body.crafterId, body.nickname, nowIso);
          syncTierNames(c);
          const idx = c.collectibles.findIndex((x) => x.id === itemId);
          if (idx < 0) {
            return { error: "Collectible not found", status: 404, crafter: c };
          }
          const item = c.collectibles[idx];
          const curTier = Number(item.tierIndex || 0);
          if (curTier >= TIERS.length - 1) {
            return { error: "Collectible is already at max tier", status: 409, crafter: c };
          }
          if ((item.count || 0) < 2) {
            return { error: "Need at least 2 matching collectibles to combine", status: 409, crafter: c };
          }
          item.count = Number(item.count || 0) - 2;
          if (item.count <= 0) {
            c.collectibles.splice(idx, 1);
          }
          const nextTier = curTier + 1;
          const nextTierName = TIERS[nextTier];
          const baseName = PART_LABELS[item.partKey] || item.name;
          const upgradedLabel = `${nextTierName} ${baseName}`;
          const existingNext = c.collectibles.find((x) => x.partKey === item.partKey && Number(x.tierIndex || 0) === nextTier);
          let targetId;
          if (existingNext) {
            existingNext.count = (existingNext.count || 1) + 1;
            targetId = existingNext.id;
          } else {
            targetId = `col_${item.partKey}_${nextTier}_${Date.now().toString(36)}`;
            c.collectibles.push({
              id: targetId,
              name: upgradedLabel,
              partKey: item.partKey,
              tierIndex: nextTier,
              tierName: nextTierName,
              count: 1
            });
          }
          c.display.spotlightItemId = targetId;
          c.xp = (c.xp || 0) + 25 * nextTier;
          c.updatedAt = nowIso;
          syncTierNames(c);
          return { crafter: c };
        }, "feat(forge): combine matching collectibles to upgrade tier");
        if (out.error) return jsonRes({ error: out.error, crafter: out.crafter }, out.status);
        return jsonRes({ crafter: out.crafter });
      }

      if (request.method === "POST" && url.pathname === "/display") {
        const body = await request.json().catch(() => ({}));
        const out = await writeStateWithRetry(env, (state, nowIso) => {
          const c = getOrCreateCrafter(state, body.crafterId, body.nickname, nowIso);
          const rawTitle = String(body.title ?? c.display.title ?? "Forge Bench").replace(/[<>&]/g, "").trim().slice(0, 32);
          const rawBio = String(body.bio ?? c.display.bio ?? "").replace(/[<>&]/g, "").trim().slice(0, 90);
          const rawTheme = String(body.theme || c.display.theme || "obsidian").toLowerCase();
          const theme = THEMES.includes(rawTheme) ? rawTheme : "obsidian";
          const spotlightId = String(body.spotlightItemId || c.display.spotlightItemId || "");
          const validSpot = c.collectibles.some((x) => x.id === spotlightId)
            ? spotlightId
            : (c.collectibles[0]?.id || null);

          c.display = {
            title: rawTitle || "Forge Bench",
            theme,
            spotlightItemId: validSpot,
            bio: rawBio
          };
          c.xp = (c.xp || 0) + 5;
          c.updatedAt = nowIso;
          syncTierNames(c);
          return { crafter: c };
        }, "feat(forge): update display showcase settings");
        if (out.error) return jsonRes({ error: out.error, crafter: out.crafter }, out.status);
        return jsonRes({ crafter: out.crafter });
      }

      return jsonRes({ error: "Not found" }, 404);
    } catch (err) {
      return jsonRes({ error: err.message }, 500);
    }
  }
};
