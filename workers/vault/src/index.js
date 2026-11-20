const DROP_POOL = [
  { id: "copper_key", name: "Copper Key", rarity: "Common", baseWeight: 55 },
  { id: "glass_vial", name: "Glass Vial", rarity: "Uncommon", baseWeight: 28 },
  { id: "star_sigil", name: "Star Sigil", rarity: "Rare", baseWeight: 12 },
  { id: "crown_prism", name: "Crown Prism", rarity: "Mythic", baseWeight: 5 }
];

const UPGRADES = [
  {
    id: "lucky_lockpick",
    name: "Lucky Lockpick",
    description: "Boosts Rare & Mythic odds by +8% total and +1 luck point.",
    costShards: 3
  },
  {
    id: "vault_tome",
    name: "Vault Tome",
    description: "Grants +25 bonus Vault XP per upgrade and unlocks extra reward tokens.",
    costShards: 4
  }
];

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

const ADJ = ["Velvet", "Silent", "Golden", "Lunar", "Cobalt", "Onyx", "Solar", "Clever"];
const NOUN = ["Cipher", "Latch", "Goblet", "Compass", "Lantern", "Chalice", "Relic", "Keystone"];

function genAnonIdentity() {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  const id = "v_" + rand[0].toString(36).slice(0, 8);
  const nick = `${ADJ[rand[1] % ADJ.length]} ${NOUN[(rand[1] >>> 8) % NOUN.length]} #${(rand[0] % 90) + 10}`;
  return { id, nickname: nick };
}

function defaultHolder(id, nickname, nowIso) {
  return {
    id,
    nickname,
    joinedAt: nowIso,
    updatedAt: nowIso,
    lastDropAt: null,
    dropCount: 0,
    xp: 0,
    shards: 2,
    upgrades: [],
    inventory: {},
    rewards: [],
    lastDrop: null
  };
}

function computeOddsTable(holder) {
  const upg = Array.isArray(holder.upgrades) ? holder.upgrades : [];
  const hasPick = upg.includes("lucky_lockpick");
  const weights = DROP_POOL.map((item) => {
    let w = item.baseWeight;
    if (hasPick && item.rarity === "Mythic") w += 3;
    if (hasPick && item.rarity === "Rare") w += 5;
    if (hasPick && item.rarity === "Common") w = Math.max(20, w - 8);
    return { ...item, weight: w };
  });
  const total = weights.reduce((s, x) => s + x.weight, 0);
  return weights.map((x) => ({
    id: x.id,
    name: x.name,
    rarity: x.rarity,
    weight: x.weight,
    oddsPct: Number(((x.weight / total) * 100).toFixed(1))
  }));
}

function rollDrop(holder) {
  const odds = computeOddsTable(holder);
  const total = odds.reduce((s, x) => s + x.weight, 0);
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  let pick = bytes[0] % total;
  for (const entry of odds) {
    if (pick < entry.weight) return { picked: entry, odds };
    pick -= entry.weight;
  }
  return { picked: odds[0], odds };
}

function canClaimDaily(holder, nowMs) {
  if (!holder.lastDropAt) return { allowed: true, nextAvailableAt: null };
  const lastMs = Date.parse(holder.lastDropAt);
  if (!Number.isFinite(lastMs)) return { allowed: true, nextAvailableAt: null };
  const cooldownMs = 24 * 60 * 60 * 1000;
  const nextMs = lastMs + cooldownMs;
  if (nowMs >= nextMs) return { allowed: true, nextAvailableAt: null };
  return { allowed: false, nextAvailableAt: new Date(nextMs).toISOString() };
}

async function readState(env) {
  const owner = env.GH_OWNER || "ram133";
  const repo = env.GH_REPO || "raygift";
  const branch = env.GH_BRANCH || "main";
  const path = env.GH_VAULT_PATH || "data/vault-state.json";
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "raygift-vault-worker",
      "Accept": "application/vnd.github+json"
    }
  });
  if (!res.ok) throw new Error(`GitHub GET failed (${res.status})`);
  const payload = await res.json();
  const decoded = atob(String(payload.content || "").replace(/\n/g, ""));
  const parsed = JSON.parse(decoded || '{"version":1,"holders":{},"claimedRewards":{}}');
  parsed.holders = parsed.holders && typeof parsed.holders === "object" ? parsed.holders : {};
  parsed.claimedRewards = parsed.claimedRewards && typeof parsed.claimedRewards === "object" ? parsed.claimedRewards : {};
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
      return {
        error: result.error,
        status: result.status || 400,
        holder: result.holder || null,
        extra: result.extra || {}
      };
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
        "User-Agent": "raygift-vault-worker",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      return { status: 200, holder: result.holder, extra: result.extra || {} };
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

function getOrCreateHolder(state, rawId, rawNick, nowIso) {
  const cleanId = typeof rawId === "string" && /^v_[a-z0-9]{4,24}$/i.test(rawId.trim()) ? rawId.trim() : null;
  if (cleanId && state.holders[cleanId]) {
    const h = state.holders[cleanId];
    h.inventory = h.inventory && typeof h.inventory === "object" ? h.inventory : {};
    h.upgrades = Array.isArray(h.upgrades) ? h.upgrades : [];
    h.rewards = Array.isArray(h.rewards) ? h.rewards : [];
    if (typeof h.shards !== "number") h.shards = 2;
    if (typeof h.xp !== "number") h.xp = 0;
    if (typeof h.dropCount !== "number") h.dropCount = 0;
    return h;
  }
  const anon = genAnonIdentity();
  const id = cleanId || anon.id;
  const safeNick = typeof rawNick === "string" && rawNick.trim()
    ? rawNick.trim().replace(/[^\w\s#-]/g, "").slice(0, 20) || anon.nickname
    : anon.nickname;
  const created = defaultHolder(id, safeNick, nowIso);
  state.holders[id] = created;
  return created;
}

function publicHolderView(h, nowMs) {
  const claimInfo = canClaimDaily(h, nowMs);
  return {
    ...h,
    canClaimDaily: claimInfo.allowed,
    nextDropAt: claimInfo.nextAvailableAt,
    odds: computeOddsTable(h),
    upgradesCatalog: UPGRADES
  };
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
        if (id && state.holders[id]) {
          return jsonRes({ holder: publicHolderView(state.holders[id], nowMs) });
        }
        return jsonRes({
          holder: null,
          catalog: DROP_POOL,
          upgradesCatalog: UPGRADES,
          claimedCount: Object.keys(state.claimedRewards || {}).length
        });
      }

      if (request.method === "POST" && url.pathname === "/init") {
        const body = await request.json().catch(() => ({}));
        const out = await writeStateWithRetry(env, (state, nowIso, nowMs) => {
          const h = getOrCreateHolder(state, body.holderId, body.nickname, nowIso);
          h.updatedAt = nowIso;
          return { holder: publicHolderView(h, nowMs) };
        }, "feat(vault): initialize anonymous vault holder");
        if (out.error) return jsonRes({ error: out.error, holder: out.holder }, out.status);
        return jsonRes({ holder: out.holder });
      }

      if (request.method === "POST" && url.pathname === "/claim") {
        const body = await request.json().catch(() => ({}));
        const out = await writeStateWithRetry(env, (state, nowIso, nowMs) => {
          const h = getOrCreateHolder(state, body.holderId, body.nickname, nowIso);
          const check = canClaimDaily(h, nowMs);
          if (!check.allowed) {
            return {
              error: "Daily Vault drop already claimed for today",
              status: 429,
              holder: publicHolderView(h, nowMs)
            };
          }
          const { picked } = rollDrop(h);
          h.inventory[picked.id] = Number(h.inventory[picked.id] || 0) + 1;
          const shardBonus = picked.rarity === "Mythic" ? 3 : picked.rarity === "Rare" ? 2 : 1;
          h.shards = Number(h.shards || 0) + shardBonus;
          h.xp = Number(h.xp || 0) + (picked.rarity === "Mythic" ? 40 : picked.rarity === "Rare" ? 25 : 15);
          h.dropCount = Number(h.dropCount || 0) + 1;
          h.lastDropAt = nowIso;
          h.updatedAt = nowIso;
          h.lastDrop = {
            id: picked.id,
            name: picked.name,
            rarity: picked.rarity,
            oddsPct: picked.oddsPct,
            shardsEarned: shardBonus,
            claimedAt: nowIso
          };
          return { holder: publicHolderView(h, nowMs), extra: { drop: h.lastDrop } };
        }, "feat(vault): claim daily vault drop");
        if (out.error) return jsonRes({ error: out.error, holder: out.holder }, out.status);
        return jsonRes({ holder: out.holder, drop: out.extra.drop });
      }

      if (request.method === "POST" && url.pathname === "/upgrade") {
        const body = await request.json().catch(() => ({}));
        const upgradeId = String(body.upgradeId || "").trim();
        const spec = UPGRADES.find((u) => u.id === upgradeId);
        if (!spec) {
          return jsonRes({ error: "Unknown upgrade ID" }, 400);
        }
        const out = await writeStateWithRetry(env, (state, nowIso, nowMs) => {
          const h = getOrCreateHolder(state, body.holderId, body.nickname, nowIso);
          if (h.upgrades.includes(upgradeId)) {
            return { error: "Upgrade already owned", status: 409, holder: publicHolderView(h, nowMs) };
          }
          if (Number(h.shards || 0) < spec.costShards) {
            return { error: `Need ${spec.costShards} shards for ${spec.name}`, status: 409, holder: publicHolderView(h, nowMs) };
          }
          h.shards = Number(h.shards || 0) - spec.costShards;
          h.upgrades.push(upgradeId);
          h.xp = Number(h.xp || 0) + (upgradeId === "vault_tome" ? 25 : 15);
          h.updatedAt = nowIso;
          return { holder: publicHolderView(h, nowMs) };
        }, `feat(vault): unlock upgrade ${upgradeId}`);
        if (out.error) return jsonRes({ error: out.error, holder: out.holder }, out.status);
        return jsonRes({ holder: out.holder });
      }

      if (request.method === "POST" && url.pathname === "/reward/create") {
        const body = await request.json().catch(() => ({}));
        const itemId = String(body.itemId || "").trim();
        const itemSpec = DROP_POOL.find((d) => d.id === itemId);
        if (!itemSpec) {
          return jsonRes({ error: "Invalid item to package into reward" }, 400);
        }
        const out = await writeStateWithRetry(env, (state, nowIso, nowMs) => {
          const h = getOrCreateHolder(state, body.holderId, body.nickname, nowIso);
          const owned = Number(h.inventory[itemId] || 0);
          if (owned <= 0) {
            return { error: `No ${itemSpec.name} in collection to share`, status: 409, holder: publicHolderView(h, nowMs) };
          }
          h.inventory[itemId] = owned - 1;
          const rand = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 6).toUpperCase();
          const code = `VLT-${rand}`;
          const tokenRecord = {
            code,
            itemId: itemSpec.id,
            itemName: itemSpec.name,
            rarity: itemSpec.rarity,
            createdBy: h.id,
            createdByNick: h.nickname,
            createdAt: nowIso,
            claimedBy: null,
            claimedAt: null
          };
          state.claimedRewards[code] = tokenRecord;
          h.rewards.unshift(tokenRecord);
          h.rewards = h.rewards.slice(0, 20);
          h.xp = Number(h.xp || 0) + 10;
          h.updatedAt = nowIso;
          return { holder: publicHolderView(h, nowMs), extra: { reward: tokenRecord } };
        }, "feat(vault): create shareable one-time reward code");
        if (out.error) return jsonRes({ error: out.error, holder: out.holder }, out.status);
        return jsonRes({ holder: out.holder, reward: out.extra.reward });
      }

      if (request.method === "POST" && url.pathname === "/reward/claim") {
        const body = await request.json().catch(() => ({}));
        const code = String(body.code || "").trim().toUpperCase();
        if (!/^VLT-[A-Z0-9]{4,12}$/.test(code)) {
          return jsonRes({ error: "Invalid reward code format" }, 400);
        }
        const out = await writeStateWithRetry(env, (state, nowIso, nowMs) => {
          const rec = state.claimedRewards[code];
          if (!rec) {
            return { error: "Reward code not found", status: 404 };
          }
          if (rec.claimedBy) {
            return { error: "Reward code has already been claimed", status: 409 };
          }
          const h = getOrCreateHolder(state, body.holderId, body.nickname, nowIso);
          rec.claimedBy = h.id;
          rec.claimedAt = nowIso;
          state.claimedRewards[code] = rec;
          h.inventory[rec.itemId] = Number(h.inventory[rec.itemId] || 0) + 1;
          h.shards = Number(h.shards || 0) + 1;
          h.xp = Number(h.xp || 0) + 15;
          h.updatedAt = nowIso;
          return { holder: publicHolderView(h, nowMs), extra: { reward: rec } };
        }, `feat(vault): redeem one-time reward ${code}`);
        if (out.error) return jsonRes({ error: out.error, holder: out.holder }, out.status);
        return jsonRes({ holder: out.holder, reward: out.extra.reward });
      }

      return jsonRes({ error: "Not found" }, 404);
    } catch (err) {
      return jsonRes({ error: err.message }, 500);
    }
  }
};
