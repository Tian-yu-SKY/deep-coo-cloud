# dsh-coo-pet

> **This directory is a fork: `dsh-coo-pet-remote` 0.4.4-remote.1 (portable/distributable build).**
> On top of upstream v0.2.1's `local` / `session` brains it adds **`brain: remote`**:
> this desktop pet is only a display; the conversation runs in a **remote DSH session**
> through a local **bridge** WebSocket, so the role card / memory / mood all come from the remote side.
> No machine-specific path is baked in: Coopanion is auto-detected, the bridge token is configured by you
> (`bridgeTokenFile` / `bridgeToken` / `DSH_COO_PET_BRIDGE_TOKEN_FILE`), and all data lives under
> `$DSH_HOME/dsh-coo-pet`.
> Since v1.1 `pet_status` also shows the bridge's mood (`GET /mood`) and reply bubble actions follow it.
> Since v1.2 it supports **multiple figure packs** (built-in coo/whale + user/Workshop packs) and a
> **DIY settings file** `dataDir/pet-settings.json` (figure axes / scale / bubble / theme … hot-applied
> within ~1s).
> Since v0.4.4 the 6 decorative icons on the dressing page floor (`/dress`) are real buttons
> (settings panel / figure folder / project home / mail / sound toggle / chat panel; whitelisted `POST /api/dock`).

> Install: [INSTALL.md](INSTALL.md) · internals/limits: [REMOTE-BRAIN.md](REMOTE-BRAIN.md) ·
> packaging: [DISTRIBUTION.md](DISTRIBUTION.md); everything below is the upstream README.

Bring the [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) desktop pet into **DeepSeek Harness (DSH)**.

She lives on your desktop, and her brain is an **independent DSH session** — she keeps her own memory,
chats with you, and can also chat with **Coo**, the pet that lives inside Coopanion. Each of them speaks
for herself, in **her own speech bubble**.

**English** | [简体中文](README.zh-CN.md)

```
     ┌──────────────────────────┐
     │  Coopanion's pet window  │  transparent, always-on-top, click-through;
     │  whale figure / roaming  │  provided by Coopanion's own pet-host
     └───────────┬──────────────┘
                 │ WebSocket (pet protocol)
     ┌───────────▼──────────────┐
     │  pet-server (this plugin)│  127.0.0.1, loopback Host only
     └───────────┬──────────────┘
                 │
     ┌───────────▼──────────────┐        ┌─────────────────────┐
     │  brain (this plugin)     │        │  Coo (Coopanion)    │
     │  own session · own memory│◄──────►│  terminal World     │
     └──────────────────────────┘        └─────────────────────┘
```

## Prerequisite: Coopanion is required

The pet's **window and appearance come entirely from Coopanion**. At startup this plugin reads them
from your installation: it takes the pages and figure assets from `cortico-world-desktop-pet/web/`,
and starts the pet window with `Coopanion.exe --pet-host`. **No Coopanion means no figure and no window.**

**This plugin redistributes nothing from Coopanion.** Those assets are AGPL-3.0, and the
`web/whale/` textures are not even covered by that: the original author states in
`THIRD_PARTY_NOTICES` that they fall outside the package's AGPL grant, and they carry the trademarks of
DeepSeek, OpenAI, Anthropic, Google, Alibaba Cloud, Moonshot AI and MiniMax. So this repository ships
not one image and not one line of somebody else's code — everything is read at runtime from the
user's own installation. See [LICENSE](LICENSE) and `lib/assets.mjs`.

The plugin finds Coopanion by itself: the `cooRoot` config first, then the Windows registry, then a few
common locations. Only when all of that fails does it report an error and ask you to set the path.

## Install

Replace `desktop` with your own DSH profile name.

```bash
# from GitHub
dsh plugin --profile desktop add github:vortioxetine213/dsh-coo-pet

# or from npm (once listed there)
dsh plugin --profile desktop add dsh-coo-pet
```

Restart DSH afterwards and she walks onto your desktop by herself.

## Updating

**This section is written for your DSH agent.** Hand it this repository URL and this text; it contains
everything needed to update you without losing her memory or appearance.

The obvious command does *not* work. `dsh plugin add` forwards straight to `pnpm add`; when a `github:`
dependency is already in the lockfile, pnpm resolves the same commit and prints `Already up to date`,
so **no new code is downloaded**. pnpm also fetches GitHub dependencies through `codeload.github.com`,
which a git `insteadOf` rewrite does not cover, so it can 404 even when `github.com` itself works.

### 1. Find out what is installed

```bash
dsh plugin --profile desktop list
```

Or read `node_modules/dsh-coo-pet/package.json` in the profile directory and compare its `version`
with the one in this repository.

### 2. Back up her data first (only on 0.1.x)

Up to **0.1.x**, her data lived *inside* the package: `data/brain.jsonl` (her memory),
`data/skin.json` (her appearance), `data/web/` (fetched assets), `data/pet-window/` (Chromium profile).
Removing the package deletes all of it. Copy the whole `data` directory somewhere safe before step 3,
then copy it back into the freshly installed package.

From **0.2.0** on the data lives in `%DSH_HOME%\dsh-coo-pet\` (usually `C:\Users\<you>\.dsh\dsh-coo-pet\`),
outside the package, so updates no longer touch it. When you upgrade from 0.1.x, the plugin moves it
there automatically on first start — just make sure the old `data` directory is still in place when
DSH starts, or copy it back yourself afterwards.

### 3. Remove, then add

```bash
dsh plugin --profile desktop remove dsh-coo-pet
dsh plugin --profile desktop add github:vortioxetine213/dsh-coo-pet
```

You must `remove` first: `add` alone is the command that prints `Already up to date`.

If `add` fails while fetching from `codeload.github.com`, clone through a mirror and install from disk:

```bash
git clone https://gh-proxy.com/https://github.com/vortioxetine213/dsh-coo-pet
dsh plugin --profile desktop add file:<the cloned directory>
```

### 4. Restart DSH

A plugin upgrade only takes effect after DSH restarts. `plugin_manager set_bundle` (disable → enable)
reloads the code, but a restart is what you want after an upgrade.

### 5. Verify

- `pet_status` should report a window, a live bubble connection and a memory size — not a degraded brain.
- If she is supposed to talk to Coo, run `/pet-chat 1` and check that at least one line comes back
  from Coo. Nothing coming back usually means Coopanion is closed, or its chat provider was renamed
  (see the changelog below — 0.2.0 handles that by itself).

### Changelog

| Version | What changed |
|---|---|
| 0.2.1 | Picks up new figure content from Coopanion even when the upgrade ships no page-code change — the asset fingerprint now covers the whole `web/` tree instead of just `pet-app.js`. That is what new outfits like Coopanion 0.2.8's crew uniform arrive as: new textures and a new `figure.json`, with the page untouched. |
| 0.2.0 | Talking to Coo auto-detects Coopanion's chat provider instead of hard-coding `world:terminal` (which Coopanion renamed to `world:console`, breaking every older copy). Her data moved out of the package directory, so updates stop wiping her memory and appearance. |
| 0.1.0 | First public release: pet window, bubble chat, independent-session brain, two-whale chat, dress page, sound, frame-rate and taskbar fixes. |

## Usage

**Talk to her.** Double-click her, or hover over her and click the "type" button that appears beside
her. What she says appears in a bubble above her head, typed out character by character.

**Let her chat with Coo.** Two entry points; neither spends tokens until you stop it.

| Where | What to do |
|---|---|
| DSH composer | `/pet-chat` to start, `/pet-chat-stop` to stop |
| On the pet | Hover over her and click the "chat with Coo" button — **it is a toggle**, click again to pause |

`/pet-chat` takes arguments too:

```
/pet-chat 5 who slacked off more today    # 5 rounds, with an opening topic
/pet-chat 0                               # keep going until you stop it
```

> Off by default. She never starts chatting on her own — both sides call a model, and that costs tokens.

## Configuration

Everything lives in `cordis.patch.yml`; reload the plugin after changing it. Usually only the first two matter.

| Key | Meaning |
|---|---|
| `cooRoot` | Coopanion's install directory. Auto-detected by default |
| `brain` | `session` (default) = her brain is an independent DSH session; `local` = a session kept inside the plugin, **no tools, cheapest** |
| `skin.scheme` | Colour scheme: `deepseek` / `harness` / `chatgpt` / `claude` / `gemini` / `qwen` / `kimi` / `minimax` |
| `chatRounds` | Default rounds for the pet button and for `/pet-chat` without a number (max 10) |
| `user` | What she calls you. Defaults to "主人" |
| `autoStart` | Walk onto the desktop on install. Default `true` |
| `port` | Port for the pet page server. A free one is picked by default |
| `petExe` | Path to `Coopanion.exe`. Defaults to the one under `cooRoot` |
| `dataDir` | Where her data lives (memory, appearance, window profile, fetched assets). Defaults to `$DSH_HOME/dsh-coo-pet`, i.e. outside the package, so upgrades do not delete it |

### The two kinds of brain

| | `local` | `session` (default) |
|---|---|---|
| Memory | `data/brain.jsonl`, last 40 turns | DSH's own persistence; the session shows up in your session list |
| Persona | The whale-maid persona built into the plugin | Your DSH preset's persona |
| Cost per turn | Small (one persona + 40 turns of history) | Larger (the preset's full system prompt and tool definitions) |
| Tools | None; she only chats | **Yes** — that session gets DSH's tools |
| Speed | Fast | Slower (a full agent loop) |

Under `session` there is a safety net: if the session backend fails (stream dropped, took too long,
preset not configured), the plugin falls back to `local` and retries once — she never goes mute
just because the backend changed.

## Tools exposed to the DSH agent

| Tool | What it does |
|---|---|
| `pet_say` | Make the pet say one line (straight to her bubble; no brain, no memory) |
| `pet_talk` | Chat with the pet; returns her actual words |
| `pet_status` | Window, bubble connection, memory size, chat switch |
| `pet_window` | `open` / `close` / `restart` her window |
| `coo_talk` | Talk to Coopanion's Coo across processes; returns her actual words |
| `pet_spar` | The chat switch (tool form) |
| `pet_forget` | Clear her memory |

## FAQ

**No pet after installing.**
Almost always Coopanion was not found. Make sure it is installed, then set the path in `cordis.patch.yml`:

```yaml
config:
  cooRoot: '<your Coopanion install dir>'
```

**The window shows up but is empty (no whale).**
Very likely a Chromium profile collision: Coopanion keeps the pet-host profile in
`<install dir>\data\pet-window`, and if its own pet is running, the two processes fight over the same
GPU cache directory and the later one cannot bring up WebGL. This plugin already points the window
profile at its own `dataDir` through `CORTICO_COMPANION_DATA` — if you changed that variable, make sure
it does not point back at Coopanion's directory.

**She talks too much and loves bullet lists.**
The plugin squashes her reply into a single line before it reaches the bubble (newlines merged,
numbering stripped, cut off past 80 characters). If it still feels long, switch `brain` to `local` —
the built-in persona is stricter about length.

## License

The code is [MIT](LICENSE). **Coopanion's assets are not covered by this project's license** — see the
prerequisite section above and the note at the end of [LICENSE](LICENSE).

## Development

See [dev/NOTES.md](dev/NOTES.md) for architecture decisions, the pitfalls we ran into, verification
records, and how to use the debugging scripts.
