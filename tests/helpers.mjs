/**
 * Test helpers.
 *
 * The extension resolves config.json relative to its own file, so every test gets
 * a throwaway sandbox: a temp directory holding a copy of the repository's
 * index.ts, its own config.json, and a package.json that marks the directory as
 * ESM (so Node's native TypeScript stripping treats the copy as a module).
 *
 * Nothing here touches a real installation, and no dependency is installed.
 */
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_SOURCE = new URL("../index.ts", import.meta.url);

/** Models shaped like the objects ctx.modelRegistry.getAvailable() returns. */
export const MODELS = [
  { provider: "openai", id: "gpt-6-sol", name: "GPT-6 Sol" },
  { provider: "deepseek", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  { provider: "openai", id: "gpt-6-luna", name: "GPT-6 Luna" },
  { provider: "openai", id: "gpt-6-sol", name: "duplicate of Sol" },
  { provider: "broken", id: "" },
  null
];

/** A fresh copy of a valid config, so tests cannot leak state into each other. */
export function baseConfig() {
  return {
    enabled: true,
    customTopLevel: "keep-me",
    nested: { keep: [1, 2, 3] },
    agents: {
      scout: { model: "openai/gpt-6-luna", thinking: "low", note: "scout-extra" },
      planner: { model: "openai/gpt-6-sol", thinking: "high" },
      worker: { model: "openai/gpt-6-sol", thinking: "medium" },
      reviewer: { model: "openai/gpt-6-sol", thinking: "high" }
    }
  };
}

/**
 * Creates an isolated sandbox.
 * `config` may be an object, a raw string (for invalid-JSON cases), or omitted
 * entirely to leave config.json missing.
 */
export async function createSandbox({ config } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "agent-model-pins-test-"));
  await writeFile(join(dir, "package.json"), '{"type": "module"}\n');
  await copyFile(EXTENSION_SOURCE, join(dir, "index.ts"));

  const configPath = join(dir, "config.json");
  if (config !== undefined) {
    await writeFile(configPath, serialize(config));
  }

  const state = {
    notifications: [],
    selects: [],
    confirms: [],
    available: [],
    queue: []
  };

  const ctx = {
    ui: {
      async select(title, options) {
        state.selects.push({ title, options });
        const step = state.queue.shift();
        if (step === undefined) return undefined;
        return typeof step === "function" ? step(options) : step;
      },
      async confirm(title, message) {
        state.confirms.push({ title, message });
        return state.queue.shift() === true;
      },
      notify(message, type) {
        state.notifications.push({ message, type });
      }
    },
    modelRegistry: {
      getAvailable: () => state.available
    }
  };

  const commands = new Map();
  const hooks = new Map();
  const extension = await import(pathToFileURL(join(dir, "index.ts")).href);
  extension.default({
    on: (name, handler) => {
      hooks.set(name, handler);
    },
    registerCommand: (name, options) => {
      commands.set(name, options);
    }
  });

  return {
    dir,
    configPath,
    state,
    ctx,
    command: commands.get("agent-models"),
    toolCallHook: hooks.get("tool_call"),
    readConfig: async () => JSON.parse(await readFile(configPath, "utf8")),
    readConfigText: () => readFile(configPath, "utf8"),
    writeConfig: (value) => writeFile(configPath, serialize(value)),
    listDir: () => readdir(dir),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

function serialize(value) {
  return typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
}

/** Queue steps for ctx.ui.select: pick the first option starting with `prefix`. */
export const pickStartsWith = (prefix) => (options) =>
  options.find((option) => option.startsWith(prefix));

/** Queue steps for ctx.ui.select: pick the first option containing `text`. */
export const pickIncludes = (text) => (options) =>
  options.find((option) => option.includes(text));

/** Cancel the current dialog (ctx.ui.select resolves to undefined). */
export const cancel = undefined;

/** Keeps expected console noise out of the test output. */
export function silenceConsoleError(t) {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
}
