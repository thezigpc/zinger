# Zinger

A party game of funny answers, for a bar's TV and everyone's phones. It runs on its own or as
a module on a Bar Games box.

1. **Write:** each player gets two prompts on their phone ("A rejected name for a crayon
   color") and types a short, funny answer to each (80 characters at most).
2. **Face-off:** the TV shows a prompt and two players' answers side by side, without names.
3. **Vote:** everyone else votes for the funnier one on their phone. The TV reveals the votes,
   who wrote each answer and the points. Every vote for one answer is a **⚡ Zinger**: bonus
   points and a big moment on the TV.
4. Round 2 is worth double. The **final round** is one prompt for everyone, and each player
   spreads 3 votes across all the answers (triple points).

## Scoring

| | Round 1 | Round 2 | Final |
|---|---|---|---|
| Each vote | 100 | 200 | 300 |
| Zinger (every vote, 2 or more) | +250 | +500 | +750 |
| Audience favourite | +100 | +200 | +300 |

- **Writers:** 3 to 10 per game by default. The admin can raise the limit to 24
  (`/admin`, "Writer limit"), and the host chooses up to that limit.
- **Audience:** everyone past the writer limit, and anyone who joins mid-game, is audience.
  Audience votes don't score points directly. The answer that wins the audience vote outright
  gets the audience bonus, and audience votes count towards a Zinger.
- **Stand-ins:** an empty answer becomes a stand-in (a short, safe joke from the pack). A
  draft that was typed but never sent still counts. A stand-in, or an answer the host hid,
  scores nothing.
- **Voting rules:** nobody votes on their own face-off or for their own final answer. Votes
  that arrive after voting closes don't count.

## Host controls

- **The usual controls:** start, end writing now, reveal now, next, skip a face-off,
  pause/resume, end game, remove a player, co-hosts (a QR invite).
- **Host on this screen:** the TV view with a control bar, for a laptop or iPad on the TV.
- **Check answers before the TV** (on by default): after writing, the host sees every answer
  and can hide any. It's skipped when no host is connected.
- **Swear filter** (on by default) masks swear words in answers and names.
- **Prompts:** family, spicy or both. Each prompt carries a tag.

## Prompt packs

- **Built in:** the sample pack ([shared/src/samplePack.ts](shared/src/samplePack.ts)), with
  151 original prompts (111 family, 40 spicy) and 40 stand-ins.
- **The venue's own:** upload CSV or JSON on `/admin`. See [examples/](examples/):
  - CSV: `prompt,tag,standin`;
  - JSON: `{ "name", "prompts": [...], "standIns": [...] }`.

## Running it

```bash
npm install
npm run dev            # server on :3015, client on :5195
npm run build && npm start -w server   # production: one origin on :3015
npm run test:build     # build, then the node:test specs
```

Docker (self-hosting): `docker compose up -d --build`. Data (the admin password hash,
settings and packs) lives in `./data`, owned by uid 1000.

| Env var | Default | |
|---|---|---|
| `PORT` | 3015 | |
| `DATA_DIR` | `./data` | |
| `GAME_NAME` | Zinger | The title (a box uses the venue's name for it) |
| `ADMIN_PASSWORD` | (unset) | Unset: set the password on the `/admin` first-run screen |
| `BASE_PATH` | (unset) | To serve under a path prefix behind your own proxy |

## On a Bar Games box

Level 3: the venue theme, events, commands, status, results, and hosting from the box. See
[BARGAMES.md](BARGAMES.md).
