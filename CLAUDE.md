# Zinger

A party game of funny answers for the Bar Games box that also runs on its own:
- players write answers to prompts;
- two answers face off on the TV and everyone votes;
- a clean sweep is a Zinger.

Box report and reference: [BARGAMES.md](BARGAMES.md). Player-facing summary: [README.md](README.md).

## Layout

npm workspaces, the shape of `C:\CodeProjects\ThisOrThat` / `BingoDigitalGame` (the
patterns this copies; don't edit them).

**shared/src**
- `protocol.ts`:
  - views, settings and scoring constants;
  - `sanitizeSettings` is the single validator; `writerLimit` caps `maxWriters`;
  - errors.
- `samplePack.ts`:
  - the built-in pack, original (never paste prompts from published games);
  - every prompt is tagged `family` or `spicy`;
  - plus the stand-in jokes.
- `packs.ts`: CSV/JSON pack parsing (pure).

**server/src**
- `rooms/Room.ts`: the state machine.
  - **Phases:** `lobby → write → check? → vote ⇄ reveal → scores → … → over`. Round 3 is
    the final.
  - **Assigning prompts:** rounds 1 and 2 form a shuffled ring (prompt i → writers i and i+1),
    so each prompt goes to exactly two writers and each writer gets two prompts. Face-offs
    are shown in a fresh shuffle.
  - **Timers:** one main timer (a phase countdown or the move-on after a reveal) plus a
    short "all in" grace, all through the kit's `safeTimeout`. Pause keeps what was left.
  - **Writers** are picked at the start: connected players in join order, up to
    `maxWriters`. Everyone else, and anyone who joins mid-game, is audience.
  - **Scoring:** `score()` and `award()`. Stand-ins and hidden answers score nothing.
  - **Views:** `view()` hides author names until the reveal. Final answers use opaque keys,
    never member ids.
- `profanity.ts`:
  - the swear filter: STEMS match word starts, WORDS match whole words (so "class" stays);
  - applied when views are built, so switching it off shows the original text.
- `content.ts`: the venue's packs (`DATA_DIR/packs`).
- `bargames.ts`: the single SDK connection (kit `wireBarGames`, `HostSeats`).
- `admin/`:
  - kit admin auth and settings (`writerLimit`, 3 to 24, default 10, and the room defaults);
  - pack uploads have their own router (`/api/admin/upload`).

**client**
- React + Vite. `RoomPage` picks `HostView` / `PlayerView` / `TableView` by role, and
  `?role=table` joins as a TV with no prompt.
- The host can show the TV view on their own screen (📺) with a control bar.
- A host who plays gets `PlayArea` (the player's pieces) inside the host screen.
- Styles: `index.css` is the shared base (copied from This or That); `zinger.css` holds
  Zinger's phone and TV styles.

## Rules

- **Standalone:** the game must behave the same with or without the SDK. Box-only behavior goes
  behind `bg.connected` / `isOnBox(ctx)`.
- **Commands** run the same `Room` method as the host's button, then broadcast.
- **URLs and storage:** never write a bare `"/api/…"`; use `serverUrl` (the path prefix under a
  box). Storage keys start with `zinger_`.
- **Colors:** the answer colors (`--card-a`, `--card-b`) and the Zinger lime (`--zap`) carry
  meaning, so don't map venue colors onto them.
- **The TV** is designed at 1920x1080 CSS, in vh/vw only, and must still work with 24 writers:
  - name chips get `dense`/`denser`;
  - the scoreboard goes to two columns past 8;
  - the final grid sizes its columns and type from `GRID` in `TableView.tsx`;
  - the join corner steps aside for a final with more than 12 answers.

  Check 720p, 1080p and 4K after any TV change.
- **Releases:** bump `version` and the `image` tag in `bargames.json` together; never re-publish a
  tag.
- **Platform:** don't edit GameBroker, GameKit or other modules. Platform needs go to the
  GameBroker session as "SDK requests".
- **Originality:** keep it original. Never use another game's name, prompts, round names or look.

## Testing

- `npm run build && npm test` (each spec spawns its own server on a free port;
  `test/game.mjs` drives a game).
- **Mock box:**
  - start it from PowerShell (Git Bash mangles `/zinger`):
    `npx bargames mock-box . --base /zinger --port 7315 --core-port 7415 --game http://127.0.0.1:3015`;
  - start the server with the env it prints (`BG_GAME_ID=zinger`);
  - then `npx bargames check . --game http://127.0.0.1:3015 --core-port 7415`.
- **Screenshots:** headless Chrome through the DevTools protocol works. Edge's and Chrome's
  `--screenshot` flag fires before the socket connects.
- **Shared PC:** several sessions share this PC. Check ports are free first, and stop only the
  PIDs on your own ports (never by process name).
