# Zinger on a Bar Games box

**Report for the Bar Games side.** Guide followed:
`C:\CodeProjects\GameBroker\integration\README.md` (SDK 0.16.0, game kit 0.9.0).

| | |
|---|---|
| Manifest | [bargames.json](bargames.json): `id: "zinger"`, port 3015, SDK level 3, `routing.basePath: true` |
| Image | `ghcr.io/thezigpc/zinger:0.1.0` (tag = `version`) |
| SDK / kit | `vendor/bargames-sdk-0.16.0.tgz`, `vendor/bargames-gamekit-0.9.0.tgz` |
| Level reached | **3** (branded, connected, controllable) |

## `npx bargames check`

Run against the mock box under `/zinger`:
- mock box: `mock-box . --base /zinger --port 7315 --core-port 7415`;
- game on 3015, with the env vars the mock box printed.

```
zinger@0.1.0 · level 3 · http://127.0.0.1:3015
✓ health /health → 200
✓ /__bargames/venue.json returns the box's branding ("Zinger (mock)")
✓ /__bargames/theme.css served
✓ "room_closed" declared (the box takes a closed room off the TVs at once)
✓ status refuses requests without the game token
✓ status → 0 room(s)
✓ unknown commands are rejected
✓ command "start" is wired (and refuses a missing room)
✓ command "pause" is wired (and refuses a missing room)
✓ command "resume" is wired (and refuses a missing room)
✓ command "next_round" is wired (and refuses a missing room)
✓ command "end" is wired (and refuses a missing room)
✓ command "host_link" is wired (and refuses a missing room)
✓ command "cohost_link" is wired (and refuses a missing room)
✓ command "remove_cohost" is wired (and refuses a missing room)
✓ create_room → room AVQV (with hostUrl)
✓ status lists AVQV as a venue room
✓ table view /room/AVQV?role=table → 200
✓ host_link answers a new host link each time (take-over)
✓ cohost_link answers single-use invites that expire
✓ end closes AVQV
✓ AVQV left status after "end"

all checks passed
```

`npx bargames validate .`: `✓ zinger@0.1.0 (sdk level 3)`. Its one warning, that the image
isn't pinned by digest, is expected.

## Events

| Event | Where | `data` |
|---|---|---|
| `room_created`, `room_closed`, `players_changed` | the kit's `wireBarGames` ([server/src/bargames.ts](server/src/bargames.ts)) | `{ title? }`, `{ reason }`, `{ players }` (writers + audience; debounced) |
| `round_started` | [server/src/rooms/Room.ts:611](server/src/rooms/Room.ts#L611) | `{ round: 1 \| 2 \| 3, final, writers }` |
| `round_ended` | [Room.ts:892](server/src/rooms/Room.ts#L892), the scores after rounds 1 and 2 (the final ends the game instead) | `{ round }` |
| `winner` | [Room.ts:918](server/src/rooms/Room.ts#L918), one per winner (ties share) | `{ name, score }` |
| `game_over` | [Room.ts:919](server/src/rooms/Room.ts#L919) | `{ rounds, winners? }` |
| `x-zinger-sweep` (custom) | [Room.ts:816](server/src/rooms/Room.ts#L816) (face-off), [Room.ts:846](server/src/rooms/Room.ts#L846) (final): one answer took every vote | `{ round, name, votes }` |

- **Results:** `bg.reportResults` at [Room.ts:922](server/src/rooms/Room.ts#L922):
  - writers only, with competition places (1, 1, 3) and their score;
  - sent at every game's end, including when staff or the host end it mid-game, once a
    face-off has been counted.
- **`x-zinger-sweep`** is the game's big moment, so a venue can flash the lights on it.

## Commands

Each command runs the same `Room` method as the host's button, then broadcasts.

| Command | Room method | Refusals |
|---|---|---|
| `create_room` | `createVenueRoom` (registry): host seat "Venue" (doesn't play), `HostSeats({ firstJoinerHosts })` | the room cap |
| `start` | `Room.start()` | already started; game over (send `next_round` to play again); fewer than 3 writers; not enough prompts for the rating |
| `next_round` | `Room.next()`, the host's main button: end writing now → start voting (after the check) → reveal now → next face-off / round scores → next round → final scores; from the end screen a new game | lobby ("send start first") |
| `pause` / `resume` | `Room.pause()` / `resume()`: timers stop and keep what was left; answers and votes still go in | not in a game; already paused / not paused |
| `end` | the kit closes the room as the host's Close room (`endCause: "host"`); a game in progress ends first, so `winner` / `game_over` / results still go out | unknown room |
| `host_link` / `cohost_link` / `remove_cohost` | kit `HostSeats` via `wireBarGames({ seats })`; take-over makes the old host a co-host ("Staff took over hosting") | unknown room; not a co-host |

- **Status:** one entry per room with `joinPath` (`/join/CODE`), `players` (writers +
  audience), `tables` and `hostName`. The title is the phase, for example
  `Friday · Round 2, face-off 3 of 8 (paused)`.
- **A venue room with no host phone:**
  - writing and voting move on by themselves once everyone connected is in, or when the
    timer runs out;
  - reveals move on after `autoNextSeconds` (default 8);
  - the check step is skipped when no host or co-host is connected.

  A room the box creates therefore plays through with no host, and `next_round` and `pause`
  are all staff need.

## Table route: `/room/{code}?role=table`

| Step 7 item | Result |
|---|---|
| The URL alone joins as a display | ✓ `TableJoin` joins as `table` and retries every 10 s; no prompt or gesture |
| No audio dependency | ✓ no sound at all |
| Fills 1920×1080, readable, safe margins | ✓ vh/vw only, text 2.15–9 vh (the 24-answer final grid is the smallest), `--bg-safe-x/y`. Screenshots at 1280×720, 1920×1080 and 1920×1080 @2x (4K) for every phase: lobby (10 writers + 4 audience), writing (8), face-off (80-character answers), the Zinger reveal, scores (16 writers: two columns), final vote and reveal (24 answers: a 6-column grid, and the join corner steps aside) |
| Recovers from restart / dropped socket | ✓ the kit's `useRoomConnection` resumes; `tableMode` shows "Reconnecting…" / "Room closed" |
| Light animation | ✓ one pop per reveal and one for the Zinger banner; static otherwise; `prefers-reduced-motion` respected |
| No pointer needed | ✓ on a box TV (`tableMode`) nothing is clickable; the full-screen button shows only off a box TV |

- **Answers on the TV:** answers reach the TV only once voting starts. Hosts and co-hosts
  check them first (on by default) and can hide any (a stand-in replaces it). The TV never
  receives the check list.
- **Writer limit:** the admin can raise it from 10 to as many as 24 writers ("Writer limit" on
  `/admin`), and the TV layouts scale to match.

## Branding and the venue

- **Chrome:** follows `--venue-*` (bg, surface, text, primary, accent, font, radius). The
  game's own colors are the fallback, so standalone nothing changes.
- **Colors that carry meaning** are never mapped to venue colors: the A/B answer cards and
  the Zinger lime.
- **Name and logo:** the venue's name for the game (`/api/config`), and the venue logo on the
  TV.
- **Venue extras:** the staff announcement on phones and TVs (`VenueAnnouncement`, which
  follows `show`), "← All games" on the landing page, and "← Box admin" plus staff sign-in
  and the box password on `/admin`.
- **Join address:** `joinDisplay(...).roomShort ?? short` with `JoinAddress`. Checked through
  the mock gateway under `/zinger`: theme, short room link, sockets and the base path all
  work.

## Container

- **Writes:** only under `DATA_DIR` (`/data`): `admin.json` (password hash),
  `settings.json`, and `packs/<id>.json`. Nothing else is written.
- **Dockerfile:** single stage, `npm ci` with `vendor/`, build, `npm prune --omit=dev`, runs
  as `node`; `docker-compose.yml` is for self-hosting. Both are the same as This or That's.
- **Clean-checkout build:** proven by the publish run below, which builds `linux/amd64`
  from a fresh checkout of the repo.
- **Read-only run: not tested.** There is no Docker on the development PC, so
  `docker run --read-only --tmpfs /tmp --cap-drop ALL -v zt:/data …` hasn't been run. The
  server writes only under `DATA_DIR`, as listed above.

## Image

- **Name:** `ghcr.io/thezigpc/zinger:0.1.0`, from commit `bf1a40f`.
- **Repo:** [github.com/thezigpc/zinger](https://github.com/thezigpc/zinger) (public).
- **Workflow:** `.github/workflows/publish-image.yml`, unchanged from the snippet.
- **First run:** [run 44007201518](https://github.com/thezigpc/zinger/actions/runs/44007201518),
  started by hand: **success**.
- **Public:** an anonymous pull of `thezigpc/zinger:0.1.0` from GHCR answers **200**, so
  the box can pull it.

## Standalone

- **No `BG_*` env:**
  - `/__bargames/venue.json` says `"standalone": true`;
  - `/api/config` returns `GAME_NAME` or "Zinger";
  - every venue extra renders nothing.
- **Tests:** `test/specs/05-bargames.test.mjs` covers this.

## Tests

`npm run build && npm test`: **37 tests, all pass.**
- **Prompt assignment:** 3, 4, 7 and 12 players; two writers per prompt; audience past the
  cap.
- **A full game:** writing, four Zinger face-offs, round scores, stand-ins, the final's vote
  spreading (own answer refused, at most 3 votes), the reveal order, the winner, play again.
- **Audience:** the bonus, and counting towards a Zinger.
- **Voting rules:** a lone vote is no Zinger, late votes are refused, a skipped face-off
  scores nothing.
- **Answers:** drafts count, stand-ins score nothing.
- **Host tools:** the check step and hiding, the swear filter (on/off, "class" left alone),
  pause.
- **Reconnects:** answers, drafts and score kept; mid-game joiners are audience until the
  next game; names; kicking.
- **Admin:**
  - setup and sign-in;
  - the writer limit (16 → a 15-writer game; hosts capped; lowering it lowers the defaults);
  - CSV/JSON packs with tags and stand-ins, the rating, packs surviving a restart;
  - closing rooms.
- **Bar Games:** standalone; every command (good room, unknown room, wrong state); events,
  `x-zinger-sweep` and results; first joiner hosts; take-over and co-hosts; the gateway's
  client IP for rate limits; `players_changed`.

## SDK requests

None blocking. Small ones:
- **A label for `next_round`:** a game like this has many steps under one Next. Today the
  box's iPad button can't say "End writing now" or "Next face-off". An optional
  `status.rooms[].next` (`{ label }`) would let it.
- **Moderation from the iPad:** the host checks answers before the TV shows them. A venue
  room with no host phone skips that step. A standard "review" list in status, shaped like
  `pendingClaims` (`{ id, text, author }`), plus a `hide_item` command, would let staff
  moderate from the iPad.
- **Audience count in status:** `players` counts writers and audience together. An optional
  `spectators` (or `audience`) field would let the Rooms page show "8 writing + 14 watching".
