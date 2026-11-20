# RayGift Table

Quick Tap 15-second mini-game + shared top-10 leaderboard.

- Play: open `/table/` (or from the Hub card).
- Leaderboard data: `leaderboard.json` (read by GitHub Pages).
- Score writes: Cloudflare Worker in `/worker` (free tier) that updates the JSON via GitHub API with optimistic concurrency.

Worker is not yet deployed. Set `window.RAYGIFT_WORKER_URL` (or hard-code it) in `index.html` after you deploy the Worker and add the `GITHUB_TOKEN` secret.
