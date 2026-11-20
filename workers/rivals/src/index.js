const ROWS = 6;
const COLS = 7;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

function makeInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function checkWinner(board, player) {
  const dirs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1]
  ];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c] !== player) continue;
      for (const [dr, dc] of dirs) {
        let count = 1;
        for (let step = 1; step < 4; step++) {
          const nr = r + dr * step;
          const nc = c + dc * step;
          if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS || board[nr][nc] !== player) break;
          count++;
        }
        if (count >= 4) return true;
      }
    }
  }
  return false;
}

function isBoardFull(board) {
  return board[0].every((cell) => cell !== 0);
}

async function readGamesFile(env) {
  const branch = env.GH_BRANCH || "main";
  const path = env.GH_RIVALS_PATH || "data/rivals-games.json";
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}?ref=${branch}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "raygift-rivals-worker",
      "Accept": "application/vnd.github+json"
    }
  });
  if (!res.ok) throw new Error(`GitHub GET failed (${res.status})`);
  const payload = await res.json();
  const decoded = atob(String(payload.content || "").replace(/\n/g, ""));
  const parsed = JSON.parse(decoded || '{"version":1,"games":{}}');
  parsed.games = parsed.games && typeof parsed.games === "object" ? parsed.games : {};
  return { state: parsed, sha: payload.sha, path, branch };
}

async function writeGamesFile(env, state, sha, path, branch, message) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}`;
  const content = btoa(JSON.stringify(state, null, 2) + "\n");
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "raygift-rivals-worker",
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ message, content, sha, branch })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT failed (${res.status}): ${text}`);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/game") {
        const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
        if (!code) return jsonResponse({ error: "Missing invite code" }, 400);
        const { state } = await readGamesFile(env);
        const game = state.games[code];
        if (!game) return jsonResponse({ error: "Game not found" }, 404);
        return jsonResponse({ game });
      }

      if (request.method === "POST" && url.pathname === "/create") {
        const body = await request.json();
        const p1Name = String(body.playerName || body.p1Name || "Player 1").trim().slice(0, 20) || "Player 1";
        let { state, sha, path, branch } = await readGamesFile(env);
        let code = makeInviteCode();
        while (state.games[code]) code = makeInviteCode();
        const now = new Date().toISOString();
        const game = {
          code,
          status: "waiting",
          board: emptyBoard(),
          players: {
            1: { name: p1Name, joinedAt: now },
            2: null
          },
          turn: 1,
          winner: null,
          isDraw: false,
          lastMove: null,
          updatedAt: now
        };
        state.games[code] = game;
        state.updatedAt = now;
        await writeGamesFile(env, state, sha, path, branch, `feat(rivals): create challenge ${code}`);
        return jsonResponse({ code, playerSlot: 1, game });
      }

      if (request.method === "POST" && url.pathname === "/join") {
        const body = await request.json();
        const code = String(body.code || "").trim().toUpperCase();
        const p2Name = String(body.playerName || body.p2Name || "Player 2").trim().slice(0, 20) || "Player 2";
        if (!code) return jsonResponse({ error: "Missing invite code" }, 400);
        const { state, sha, path, branch } = await readGamesFile(env);
        const game = state.games[code];
        if (!game) return jsonResponse({ error: "Game not found" }, 404);
        const now = new Date().toISOString();
        if (!game.players[2]) {
          game.players[2] = { name: p2Name, joinedAt: now };
          if (game.status === "waiting") game.status = "active";
          game.updatedAt = now;
          state.games[code] = game;
          state.updatedAt = now;
          await writeGamesFile(env, state, sha, path, branch, `feat(rivals): ${p2Name} joined ${code}`);
        }
        return jsonResponse({ code, playerSlot: 2, game });
      }

      if (request.method === "POST" && url.pathname === "/move") {
        const body = await request.json();
        const code = String(body.code || "").trim().toUpperCase();
        const player = Number(body.player);
        const col = Number(body.col);
        const moveId = body.moveId ? String(body.moveId).slice(0, 64) : null;

        if (!code || (player !== 1 && player !== 2) || !Number.isInteger(col) || col < 0 || col >= COLS) {
          return jsonResponse({ error: "Invalid move payload" }, 400);
        }

        const { state, sha, path, branch } = await readGamesFile(env);
        const game = state.games[code];
        if (!game) return jsonResponse({ error: "Game not found" }, 404);
        if (game.winner || game.isDraw || game.status === "finished") {
          return jsonResponse({ error: "Game is already finished" }, 409);
        }
        if (!game.players[1] || !game.players[2]) {
          return jsonResponse({ error: "Both players must join before moving" }, 409);
        }
        if (moveId && game.lastMove && game.lastMove.moveId === moveId) {
          return jsonResponse({ error: "Duplicate move submission rejected", game }, 409);
        }
        if (game.turn !== player) {
          return jsonResponse({ error: "Out-of-turn move rejected", game }, 409);
        }

        let placedRow = -1;
        for (let r = ROWS - 1; r >= 0; r--) {
          if (game.board[r][col] === 0) {
            placedRow = r;
            break;
          }
        }
        if (placedRow === -1) {
          return jsonResponse({ error: "Column is full" }, 409);
        }

        game.board[placedRow][col] = player;
        const now = new Date().toISOString();
        game.lastMove = { player, row: placedRow, col, moveId, at: now };
        game.updatedAt = now;

        if (checkWinner(game.board, player)) {
          game.winner = player;
          game.status = "finished";
        } else if (isBoardFull(game.board)) {
          game.isDraw = true;
          game.status = "finished";
        } else {
          game.status = "active";
          game.turn = player === 1 ? 2 : 1;
        }

        state.games[code] = game;
        state.updatedAt = now;
        await writeGamesFile(env, state, sha, path, branch, `chore(rivals): move P${player} col ${col + 1} in ${code}`);
        return jsonResponse({ game });
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }
};
