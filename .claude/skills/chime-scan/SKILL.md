---
name: chime-scan
description: Run one Chime In scan (watchlist → Apify → theme/expertise/contribution scoring → KB-grounded drafts → Wingman candidates) and summarise the funnel and candidates for the user. Never posts to X.
---

# Chime In scan

1. Make sure the Wingman daemon is running (`GET http://localhost:53827/health`).
   If not, tell the user to start it: `npm --workspace @wingman-x/daemon run dev`.
2. From the repo root run `npm run scan` (add `-- --dry-run` if the user
   only wants to preview, `-- --handles a,b` for a subset, `-- --since 12h`
   to widen or narrow the window).
3. Read the funnel summary and the report path it prints
   (`~/.wingman-x/chime-in/scans/<timestamp>.json`).
4. Report to the user: accounts checked, new posts, theme matches,
   expertise matches, contribution candidates, candidates sent, and for
   each candidate the handle, URL, angle, and drafted reply. Mention
   anything with `ai_tell_flags`.
5. If the user wants a different draft for a candidate, tell them to press
   ♻️ in the extension and then run `npm run regen` (or the next scan).

Do not edit the knowledge base or the watchlist unless the user asks.
Never attempt to post to X; the user posts from the extension.
