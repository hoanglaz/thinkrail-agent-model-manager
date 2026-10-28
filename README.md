# thinkrail-agent-model-pins

Pin a **model and thinking level per subagent** in ThinkRail / pi — `scout`, `planner`, `worker`
and `reviewer` — and edit those pins from inside the app with the `/agent-models` command.

No dependencies, no build step, no network access. Two files: one extension, one JSON config.

```
/agent-models
  → Which subagent do you want to configure?
      scout — openai/gpt-6-luna (thinking: low)
      planner — openai/gpt-6-sol (thinking: high)
      worker — openai/gpt-6-sol (thinking: medium)
      reviewer — openai/gpt-6-sol (thinking: high)
  → scout — current: openai/gpt-6-luna (thinking: low) — choose a model
  → scout → openai/gpt-6-sol — choose a thinking level
  → Save scout?   Previous: … / New: openai/gpt-6-sol (thinking: high)
```

## What it does

1. **Pins models.** A `tool_call` hook intercepts every `Agent` tool call and, when the requested
   `subagent_type` has a pin, sets the model (and thinking level) for that subagent before it is
   spawned. Without a pin, the subagent keeps inheriting the parent's model.
2. **Edits pins interactively.** `/agent-models` walks you through agent → model → thinking level →
   confirmation and writes `config.json` atomically. Cancelling any step changes nothing.

The two mechanisms share one file: the hook re-reads `config.json` on every call, so a pin saved by
the command takes effect on the very next subagent spawn.

## Compatibility

| | |
|---|---|
| **ThinkRail** | **0.3.0-nightly.7 — verified** |
| pi runtime | uses `pi.registerCommand`, `pi.on("tool_call")`, `ctx.ui.select/confirm/notify` and `ctx.modelRegistry.getAvailable()` |
| Platforms | macOS and Linux (the installers are `bash`; the extension itself is portable) |
| Node.js | **only for running the test suite** — Node ≥ 22.6, verified on 26.3. Not needed at runtime. |

Verification status: the extension API surface this project uses was verified against the
`0.3.0-nightly.7` runtime bundle, and all extension logic is covered by the test suite (51 tests).
The dialogs were not exercised in a live session on that build — see
[Troubleshooting](#troubleshooting) if a dialog does not appear.

## Requirements

- ThinkRail (or a pi runtime with the same extension API).
- A shell and `cp`/`mv` for the installers.
- Nothing else. No Pi CLI, no npm install, no build.

## Installation

```bash
git clone <your-fork-url> thinkrail-agent-model-manager
cd thinkrail-agent-model-manager
./install.sh
```

The installer writes to `<agent-dir>/extensions/agent-model-pins/`, where `<agent-dir>` is:

1. `$PI_CODING_AGENT_DIR` if that variable is set, otherwise
2. `~/.pi/agent`.

Options:

```bash
./install.sh --agent-dir /path/to/agent   # install somewhere else
./install.sh --dry-run                    # show what would happen
./install.sh --help
```

What it does, and what it refuses to do:

- **Copies `index.ts`** into the extension directory. An existing `index.ts` is first copied to
  `index.ts.backup-<timestamp>` — nothing is overwritten silently.
- **Never touches an existing `config.json`.** Your pins survive reinstalls and updates.
- **Creates `config.json` from `config.example.json`** only when there is none yet.
- Verifies the copy byte-for-byte and fails loudly if it differs.

Manual installation, if you prefer:

```bash
mkdir -p ~/.pi/agent/extensions/agent-model-pins
cp index.ts ~/.pi/agent/extensions/agent-model-pins/index.ts
cp config.example.json ~/.pi/agent/extensions/agent-model-pins/config.json   # only if you have none
```

Then **restart ThinkRail** (or reload the session) so the extension is re-imported, and run
`/agent-models` in any chat.

## Usage

### The `/agent-models` command

Type `/agent-models` in the chat composer and send it. It is handled locally by the extension — no
model turn is started, no tokens are spent.

1. **Agent** — the four built-in subagent types, each showing its current pin. Agents you added to
   `config.json` by hand are appended, so they stay editable.
2. **Model** — every model available in the current session, as `provider/id`, sorted by provider
   and id and de-duplicated. If the agent's current model is no longer available, it is still offered
   and labelled `(currently pinned — not in the available list)`.
3. **Thinking level** — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; the current one is
   marked `(current)`.
4. **Confirm** — shows the agent, the previous pin and the new pin. Decline or cancel and nothing is
   written; a single "Cancelled — no changes were made." notice is shown.

### Editing `config.json` by hand

Same effect, no dialogs:

```json
{
  "enabled": true,
  "agents": {
    "scout":    { "model": "openai/gpt-6-luna", "thinking": "low" },
    "planner":  { "model": "openai/gpt-6-sol",  "thinking": "high" },
    "worker":   { "model": "openai/gpt-6-sol",  "thinking": "medium" },
    "reviewer": { "model": "openai/gpt-6-sol",  "thinking": "high" }
  }
}
```

| Key | Meaning |
|---|---|
| `enabled` | Master switch. `false` disables all pinning; `/agent-models` still works and preserves the value. |
| `agents.<name>.model` | `provider/id` exactly as it appears in the model list (e.g. `openai/gpt-6-sol`). |
| `agents.<name>.thinking` | One of the seven levels. Omit to inherit the parent's thinking level. |

Any other keys — at the top level or inside an agent entry — are preserved untouched.

Notes:

- A `model` written as `provider/id:level` is accepted, but `/agent-models` normalises it to
  `provider/id` plus a separate `thinking` value, because the extension appends its own level and
  `provider/id:level:level` is not a resolvable reference.
- Model ids containing a colon (e.g. `amazon/nova-2-lite-v1:0`) are handled correctly — only a
  trailing segment that is exactly one of the seven levels is treated as a thinking suffix.
- Pin a model that is available in your session, otherwise the spawn fails with
  `Agent "x" pins model "y", which is not available in this session`.

### The two reviewer paths — read this before pinning "reviewer"

| Path | Reads `config.json`? | Where its model comes from |
|---|---|---|
| `Agent(subagent_type: "reviewer")` | **yes** | this extension's `config.json` |
| `request_review` (plan-step review) | **no** | ThinkRail → **Settings → Models** (`reviewModel` / `reviewEffort`) |

`request_review` uses its own built-in prompt and tools and never consults this file, so pinning
`reviewer` here does not change plan-step reviews. The confirmation dialog reminds you of this when
you edit the reviewer. Use the app's settings for the plan-review model.

## Updates

```bash
cd thinkrail-agent-model-manager
git pull
./install.sh
```

Re-running the installer is safe and is the update path: the old `index.ts` is backed up, your
`config.json` is left alone. Restart ThinkRail (or reload the session) afterwards.

To roll back the code:

```bash
cp ~/.pi/agent/extensions/agent-model-pins/index.ts.backup-<timestamp> \
   ~/.pi/agent/extensions/agent-model-pins/index.ts
# or
./uninstall.sh --restore-backup
```

## Troubleshooting

**`/agent-models` is not in the list / "Unknown command".**
The extension is loaded when the session starts. Restart ThinkRail, or reload the session, then try
again. Confirm the files are where the runtime looks for them:

```bash
ls -l "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/agent-model-pins/"
```

Both `index.ts` and `config.json` must be there. If you set the agent directory in ThinkRail's
Settings → Environment, install with `--agent-dir` pointing at that same directory.

**A dialog never appears.** The command needs a UI context; in a headless/print run there is none.
In ThinkRail, a pending dialog appears in the chat and is cancelled if you send a message instead of
answering it. Extension errors are surfaced as a notification in the chat.

**Nothing is pinned / subagents still use the parent model.**
- Is `"enabled": true`?
- Is `config.json` valid JSON? The hook fails silently on a broken file (it logs
  `[agent-model-pins] Config error: …`), while `/agent-models` reports it as an error notification.
- Does the agent name match exactly (`scout`, not `Scout`)?
- A pin only applies to `Agent` tool calls — it cannot affect `request_review` (see above).

**`Agent "worker" pins model "…", which is not available in this session`.**
The pinned model is not available in this session — usually an API key or sign-in is missing for that
provider. Re-pin it with `/agent-models`, which lists what is actually available.

**The subagent fails with a subscription/quota error.**
That is an account limit, not an extension problem. Pinning a cheap or differently authenticated
model per agent is exactly what this extension is for — pick another model for that agent.

**The thinking level is ignored.** The model must support the level; the runtime clamps unsupported
levels to what the model offers. The seven levels are `off` … `max`.

**Verifying what a subagent actually used.** Every delegated run writes a transcript:

```
~/.thinkrail/delegation/<workspaceId>/<parentSessionId>/<timestamp>_<childSessionId>.jsonl
```

The first records are `{"type":"model_change","provider":…,"modelId":…}` and
`{"type":"thinking_level_change","thinkingLevel":…}` — they show exactly what the pin produced.

**Reporting a bug.** Include your ThinkRail version, the extension version, the relevant part of
`config.json` (redact anything private) and any notification text. Do not paste API keys.

## Uninstall

```bash
./uninstall.sh                 # removes index.ts, keeps your config.json
./uninstall.sh --restore-backup # puts the newest backup back instead
./uninstall.sh --purge --yes   # removes the whole directory, config.json included
./uninstall.sh --dry-run
```

By default your `config.json` and any `index.ts.backup-*` files are kept — they are your data.
Restart ThinkRail (or reload the session) afterwards to unload the extension.

## Development

No dependencies and no build step. Run the test suite with Node's built-in runner:

```bash
npm test          # or: node --test
```

The suite copies `index.ts` into a throwaway temp directory per test, so it never touches a real
installation, and it stubs the extension API (`pi`, `ctx.ui`, `ctx.modelRegistry`).

| File | Covers |
|---|---|
| `tests/config.test.mjs` | config persistence: atomic write, preserved fields, file mode, missing file, invalid JSON, write failure, no temp leftovers |
| `tests/command.test.mjs` | command flow: agent/model/thinking options, sorting, de-duplication, unavailable pins, confirmation contents, success and error notices |
| `tests/cancellation.test.mjs` | cancellation at each step and at the confirmation — never a partial write |
| `tests/pinning.test.mjs` | the `tool_call` hook: pins, dynamic re-reads, disabled state, unknown agents, invalid levels |

```
.
├── index.ts             the extension (the only file that runs in ThinkRail)
├── config.example.json  starting configuration
├── install.sh           installer / updater
├── uninstall.sh         uninstaller
├── package.json         test script only; no dependencies
├── tests/               node:test suite
└── LICENSE
```

## How it works

The extension registers one `tool_call` hook and one command.

- **Hook.** On an `Agent` tool call it re-reads `config.json`; if the requested `subagent_type` has a
  pin it sets `event.input.model` to `provider/id:thinking`. A definition-level pin or the model
  passed by the caller otherwise wins — this only fills in a model the caller did not pin.
- **Command.** Reads the config fresh, asks for the three choices through the host UI, and writes the
  merged object to a temp file in the same directory followed by an atomic `rename` over
  `config.json`, preserving the original file mode. The shape is validated before writing; on any
  error nothing is written and the failure is reported through `ctx.ui.notify`.

## License

MIT — see [LICENSE](LICENSE).
