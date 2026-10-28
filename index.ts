import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type AgentConfig = {
  model: string;
  thinking?: string;
};

type Config = {
  enabled: boolean;
  agents: Record<string, AgentConfig>;
};

// The pi type package is not installed, so the slice of the command context this
// command uses is declared locally. It mirrors ThinkRail 0.3.0-nightly.7's
// createWebUiContext() (server-runtime.ts:710384) and createCommandContext() (:265444).
type CommandContext = {
  ui: {
    select(
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal; timeout?: number }
    ): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  modelRegistry: {
    getAvailable(): unknown[];
  };
};

const CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "config.json"
);

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

// The built-in subagent types this command configures. Any other agent already
// present in config.json is appended, so hand-written entries stay editable.
const BUILTIN_AGENT_NAMES = ["scout", "planner", "worker", "reviewer"];

const UNAVAILABLE_SUFFIX = "  (currently pinned — not in the available list)";
const CURRENT_SUFFIX = "  (current)";

// Agent(subagent_type:"reviewer") reads this file. request_review does not: it uses
// ThinkRail → Settings → Models (reviewModel / reviewEffort). Keep the two apart.
const REVIEWER_NOTE = `Note: this pins Agent(subagent_type: "reviewer") only.
request_review ignores this file and uses ThinkRail → Settings → Models
(reviewModel / reviewEffort).`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVEL_SET.has(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `provider/id:level` is not a valid model reference for this extension: the
 * tool_call hook appends its own `:level`, so a stored suffix would produce
 * `provider/id:level:level` and the spawn would fail. The thinking level is stored
 * separately, so a recognised trailing suffix is dropped on the way in.
 */
function stripThinkingSuffix(model: string): string {
  const colon = model.lastIndexOf(":");
  if (colon <= 0) return model;
  const suffix = model.slice(colon + 1);
  return isThinkingLevel(suffix) ? model.slice(0, colon) : model;
}

/** Tolerant read used by the tool_call hook: any problem means the hook does nothing. */
function loadConfig(): Config | null {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as Config;
  } catch (error) {
    console.error("[agent-model-pins] Config error:", error);
    return null;
  }
}

type FreshRead =
  | { ok: true; raw: Record<string, unknown>; created: boolean }
  | { ok: false; error: string };

/**
 * Fresh read for one command invocation. Returns the parsed object untouched so
 * unrelated fields survive the round trip; only the shape this extension relies on
 * is checked. A missing file is treated as empty defaults (and reported as created).
 */
function readConfigFresh(): FreshRead {
  let text: string;
  try {
    text = readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { ok: true, raw: { enabled: true, agents: {} }, created: true };
    }
    return {
      ok: false,
      error: `Could not read ${CONFIG_PATH}: ${errorMessage(error)}`
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `${CONFIG_PATH} is not valid JSON: ${errorMessage(error)}`
    };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: `${CONFIG_PATH} must contain a JSON object` };
  }
  if (parsed.enabled !== undefined && typeof parsed.enabled !== "boolean") {
    return {
      ok: false,
      error: `${CONFIG_PATH}: "enabled" must be true or false`
    };
  }
  if (parsed.agents !== undefined && !isRecord(parsed.agents)) {
    return { ok: false, error: `${CONFIG_PATH}: "agents" must be an object` };
  }
  if (isRecord(parsed.agents)) {
    for (const [name, entry] of Object.entries(parsed.agents)) {
      if (!isRecord(entry)) {
        return {
          ok: false,
          error: `${CONFIG_PATH}: agents["${name}"] must be an object`
        };
      }
    }
  }
  return { ok: true, raw: parsed, created: false };
}

function readAgentEntry(
  raw: Record<string, unknown>,
  agentName: string
): { model: string | null; thinking: ThinkingLevel | null } {
  const agents = isRecord(raw.agents) ? raw.agents : {};
  const entry = agents[agentName];
  if (!isRecord(entry)) return { model: null, thinking: null };
  const model =
    typeof entry.model === "string" && entry.model.trim() !== ""
      ? entry.model.trim()
      : null;
  return {
    model,
    thinking: isThinkingLevel(entry.thinking) ? entry.thinking : null
  };
}

function orderedAgentNames(raw: Record<string, unknown>): string[] {
  const configured = isRecord(raw.agents) ? Object.keys(raw.agents) : [];
  const extras = configured
    .filter((name) => !BUILTIN_AGENT_NAMES.includes(name))
    .sort((a, b) => a.localeCompare(b));
  return [...BUILTIN_AGENT_NAMES, ...extras];
}

function describeCurrent(model: string | null, thinking: ThinkingLevel | null): string {
  if (model === null) return "no model configured";
  return thinking === null ? model : `${model} (thinking: ${thinking})`;
}

/**
 * Model options as `provider/id`, sorted by provider then id and de-duplicated.
 * The currently pinned model is appended when it is not in the available list.
 */
function buildModelChoices(
  available: readonly unknown[],
  currentModel: string | null
): { labels: string[]; valueOf: Map<string, string> } {
  const seen = new Set<string>();
  const refs: Array<{ provider: string; id: string }> = [];

  for (const candidate of available) {
    if (!isRecord(candidate)) continue;
    const provider =
      typeof candidate.provider === "string" ? candidate.provider.trim() : "";
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (provider === "" || id === "") continue;
    const key = `${provider}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ provider, id });
  }

  refs.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)
  );

  const labels: string[] = [];
  const valueOf = new Map<string, string>();
  for (const ref of refs) {
    const key = `${ref.provider}/${ref.id}`;
    labels.push(key);
    valueOf.set(key, key);
  }

  if (currentModel !== null) {
    const base = stripThinkingSuffix(currentModel);
    if (!seen.has(base)) {
      labels.push(`${currentModel}${UNAVAILABLE_SUFFIX}`);
      valueOf.set(`${currentModel}${UNAVAILABLE_SUFFIX}`, base);
    }
  }

  return { labels, valueOf };
}

function buildThinkingChoices(current: ThinkingLevel | null): {
  labels: string[];
  valueOf: Map<string, ThinkingLevel>;
} {
  const labels: string[] = [];
  const valueOf = new Map<string, ThinkingLevel>();
  for (const level of THINKING_LEVELS) {
    const label = level === current ? `${level}${CURRENT_SUFFIX}` : level;
    labels.push(label);
    valueOf.set(label, level);
  }
  return { labels, valueOf };
}

/** Refuses to serialise a file this extension would not be able to read back. */
function assertWritable(value: unknown): asserts value is Config {
  if (!isRecord(value)) {
    throw new Error('refusing to write: config is not a JSON object');
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error('refusing to write: "enabled" must be true or false');
  }
  if (!isRecord(value.agents)) {
    throw new Error('refusing to write: "agents" must be an object');
  }
  for (const [name, entry] of Object.entries(value.agents)) {
    if (!isRecord(entry)) {
      throw new Error(`refusing to write: agents["${name}"] must be an object`);
    }
    if (entry.model !== undefined) {
      if (typeof entry.model !== "string" || entry.model.trim() === "") {
        throw new Error(
          `refusing to write: agents["${name}"].model must be a non-empty string`
        );
      }
    }
    if (entry.thinking !== undefined && !isThinkingLevel(entry.thinking)) {
      throw new Error(
        `refusing to write: agents["${name}"].thinking must be one of ${THINKING_LEVELS.join(", ")}`
      );
    }
  }
}

/** Temp file in the same directory, then an atomic rename over config.json. */
function writeConfigAtomic(config: Config): void {
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  const directory = dirname(CONFIG_PATH);
  const tempPath = join(
    directory,
    `.config.json.${process.pid}.${Date.now().toString(36)}.tmp`
  );

  let mode = 0o644;
  try {
    mode = statSync(CONFIG_PATH).mode & 0o777;
  } catch {
    // No existing file: fall back to the default mode.
  }

  try {
    writeFileSync(tempPath, serialized, { encoding: "utf8", mode });
    renameSync(tempPath, CONFIG_PATH);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp file may never have been created.
    }
    throw error;
  }
}

function notifyCancelled(ctx: CommandContext): void {
  ctx.ui.notify("Cancelled — no changes were made.", "info");
}

async function runAgentModelsCommand(ctx: CommandContext): Promise<void> {
  const read = readConfigFresh();
  if (!read.ok) {
    ctx.ui.notify(read.error, "error");
    return;
  }

  const agentNames = orderedAgentNames(read.raw);
  const agentLabels = agentNames.map((name) => {
    const entry = readAgentEntry(read.raw, name);
    return `${name} — ${describeCurrent(entry.model, entry.thinking)}`;
  });
  const agentByLabel = new Map(
    agentLabels.map((label, index) => [label, agentNames[index] as string])
  );

  const agentLabel = await ctx.ui.select(
    "Which subagent do you want to configure?",
    agentLabels
  );
  if (agentLabel === undefined) {
    notifyCancelled(ctx);
    return;
  }
  const agentName = agentByLabel.get(agentLabel);
  if (agentName === undefined) {
    ctx.ui.notify(`Unknown selection "${agentLabel}". No changes were made.`, "error");
    return;
  }

  const previous = readAgentEntry(read.raw, agentName);

  let available: unknown[];
  try {
    available = ctx.modelRegistry.getAvailable();
  } catch (error) {
    ctx.ui.notify(
      `Could not list available models: ${errorMessage(error)}. No changes were made.`,
      "error"
    );
    return;
  }

  const models = buildModelChoices(available, previous.model);
  if (models.labels.length === 0) {
    ctx.ui.notify(
      "No models are available in this session and none is pinned yet, so there is nothing to choose from. No changes were made.",
      "warning"
    );
    return;
  }

  const modelLabel = await ctx.ui.select(
    `${agentName} — current: ${describeCurrent(previous.model, previous.thinking)} — choose a model`,
    models.labels
  );
  if (modelLabel === undefined) {
    notifyCancelled(ctx);
    return;
  }
  const model = models.valueOf.get(modelLabel);
  if (model === undefined) {
    ctx.ui.notify(`Unknown model selection. No changes were made.`, "error");
    return;
  }

  const thinking = buildThinkingChoices(previous.thinking);
  const thinkingLabel = await ctx.ui.select(
    `${agentName} → ${model} — choose a thinking level`,
    thinking.labels
  );
  if (thinkingLabel === undefined) {
    notifyCancelled(ctx);
    return;
  }
  const thinkingLevel = thinking.valueOf.get(thinkingLabel);
  if (thinkingLevel === undefined) {
    ctx.ui.notify(`Unknown thinking level. No changes were made.`, "error");
    return;
  }

  const confirmation = [
    `Agent:    ${agentName}`,
    `Previous: ${describeCurrent(previous.model, previous.thinking)}`,
    `New:      ${model} (thinking: ${thinkingLevel})`,
    "",
    `Write to ${CONFIG_PATH}?`,
    ...(agentName === "reviewer" ? ["", REVIEWER_NOTE] : [])
  ].join("\n");

  const confirmed = await ctx.ui.confirm(`Save ${agentName}?`, confirmation);
  if (!confirmed) {
    notifyCancelled(ctx);
    return;
  }

  const agents = isRecord(read.raw.agents) ? { ...read.raw.agents } : {};
  const existing = isRecord(agents[agentName]) ? agents[agentName] : {};
  agents[agentName] = { ...existing, model, thinking: thinkingLevel };
  const next: Record<string, unknown> = { ...read.raw, agents };

  try {
    assertWritable(next);
    writeConfigAtomic(next);
  } catch (error) {
    ctx.ui.notify(
      `Could not save ${CONFIG_PATH}: ${errorMessage(error)}`,
      "error"
    );
    return;
  }

  const created = read.created ? " (config.json was created)" : "";
  ctx.ui.notify(
    `Saved ${agentName} → ${model} (thinking: ${thinkingLevel})${created}. New subagent spawns pick this up immediately.`,
    "info"
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "Agent") return;

    const config = loadConfig();

    if (!config?.enabled) return;

    const input = event.input as {
      subagent_type?: string;
      model?: string;
    };

    const agentName = input.subagent_type;

    if (!agentName) return;

    const agent = config.agents?.[agentName];

    if (!agent?.model) return;

    const thinking = agent.thinking;

    if (thinking && !THINKING_LEVEL_SET.has(thinking)) {
      console.error(
        `[agent-model-pins] Invalid thinking: ${thinking}`
      );
      return;
    }

    input.model = thinking
      ? `${agent.model}:${thinking}`
      : agent.model;

    console.log(
      `[agent-model-pins] ${agentName} -> ${input.model}`
    );
  });

  pi.registerCommand("agent-models", {
    description: "Set the model and thinking level each subagent uses",
    handler: async (_args, ctx) => {
      try {
        await runAgentModelsCommand(ctx as CommandContext);
      } catch (error) {
        ctx.ui.notify(`/agent-models failed: ${errorMessage(error)}`, "error");
      }
    }
  });
}
