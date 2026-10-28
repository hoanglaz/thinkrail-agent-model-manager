import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, readdir, stat } from "node:fs/promises";

import {
  baseConfig,
  createSandbox,
  MODELS,
  pickStartsWith,
  silenceConsoleError
} from "./helpers.mjs";

/** Drives the command to a successful save for `agent` -> `model`/`thinking`. */
async function save(sandbox, { agent, model, thinking }) {
  sandbox.state.available = MODELS;
  sandbox.state.queue = [
    pickStartsWith(agent),
    pickStartsWith(model),
    pickStartsWith(thinking),
    true
  ];
  await sandbox.command.handler("", sandbox.ctx);
}

test("writes the selected model and thinking level", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  await save(sandbox, { agent: "scout", model: "openai/gpt-6-sol", thinking: "high" });

  const config = await sandbox.readConfig();
  assert.equal(config.agents.scout.model, "openai/gpt-6-sol");
  assert.equal(config.agents.scout.thinking, "high");
});

test("preserves unrelated top-level fields and sibling agents", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  await save(sandbox, { agent: "worker", model: "openai/gpt-6-luna", thinking: "off" });

  const config = await sandbox.readConfig();
  assert.equal(config.customTopLevel, "keep-me");
  assert.deepEqual(config.nested, { keep: [1, 2, 3] });
  assert.equal(config.enabled, true);
  assert.equal(config.agents.worker.model, "openai/gpt-6-luna");
  assert.equal(config.agents.worker.thinking, "off");
  assert.deepEqual(config.agents.scout, {
    model: "openai/gpt-6-luna",
    thinking: "low",
    note: "scout-extra"
  });
  assert.equal(config.agents.planner.thinking, "high");
  assert.equal(config.agents.reviewer.thinking, "high");
});

test("preserves extra fields inside the edited agent entry", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  await save(sandbox, { agent: "scout", model: "openai/gpt-6-sol", thinking: "max" });

  const config = await sandbox.readConfig();
  assert.equal(config.agents.scout.note, "scout-extra");
});

test("writes valid JSON with a trailing newline", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  await save(sandbox, { agent: "scout", model: "openai/gpt-6-sol", thinking: "low" });

  const text = await sandbox.readConfigText();
  assert.ok(text.endsWith("\n"), "file should end with a newline");
  assert.doesNotThrow(() => JSON.parse(text));
});

test("keeps the file mode of the existing config.json", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  await chmod(sandbox.configPath, 0o600);

  await save(sandbox, { agent: "scout", model: "openai/gpt-6-sol", thinking: "low" });

  const mode = (await stat(sandbox.configPath)).mode & 0o777;
  assert.equal(mode.toString(8), "600");
});

test("leaves no temporary file behind", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  await save(sandbox, { agent: "scout", model: "openai/gpt-6-sol", thinking: "low" });

  const leftovers = (await sandbox.listDir()).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("creates config.json with enabled: true when it is missing", async (t) => {
  const sandbox = await createSandbox();
  t.after(() => sandbox.cleanup());

  await save(sandbox, { agent: "scout", model: "openai/gpt-6-sol", thinking: "high" });

  const config = await sandbox.readConfig();
  assert.equal(config.enabled, true);
  assert.deepEqual(config.agents, {
    scout: { model: "openai/gpt-6-sol", thinking: "high" }
  });
  assert.ok(
    sandbox.state.notifications.some((n) => n.message.includes("config.json was created")),
    "the user should be told the file was created"
  );
});

test("reports invalid JSON and writes nothing", async (t) => {
  const sandbox = await createSandbox({ config: "{ not json " });
  t.after(() => sandbox.cleanup());

  await sandbox.command.handler("", sandbox.ctx);

  const error = sandbox.state.notifications.find((n) => n.type === "error");
  assert.ok(error, "an error notification is expected");
  assert.match(error.message, /not valid JSON/);
  assert.equal(sandbox.state.selects.length, 0, "no dialog should open");
  assert.equal(await sandbox.readConfigText(), "{ not json ");
});

test("reports a config that is not a JSON object", async (t) => {
  const sandbox = await createSandbox({ config: "[1, 2, 3]" });
  t.after(() => sandbox.cleanup());

  await sandbox.command.handler("", sandbox.ctx);

  const error = sandbox.state.notifications.find((n) => n.type === "error");
  assert.ok(error);
  assert.match(error.message, /must contain a JSON object/);
});

test("reports an agent entry that is not an object", async (t) => {
  const sandbox = await createSandbox({
    config: { enabled: true, agents: { scout: "not-an-object" } }
  });
  t.after(() => sandbox.cleanup());

  await sandbox.command.handler("", sandbox.ctx);

  const error = sandbox.state.notifications.find((n) => n.type === "error");
  assert.ok(error);
  assert.match(error.message, /must be an object/);
});

test("keeps the file intact when the write fails", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  const before = await sandbox.readConfigText();

  await chmod(sandbox.dir, 0o555);
  try {
    await save(sandbox, { agent: "scout", model: "openai/gpt-6-sol", thinking: "high" });
  } finally {
    await chmod(sandbox.dir, 0o755);
  }

  const error = sandbox.state.notifications.find((n) => n.type === "error");
  assert.ok(error, "a failed write must be reported");
  assert.match(error.message, /Could not save/);
  assert.equal(await sandbox.readConfigText(), before);
  assert.deepEqual(
    (await sandbox.listDir()).filter((name) => name.endsWith(".tmp")),
    []
  );
});

test("accepts a config with no agents key and keeps enabled", async (t) => {
  const sandbox = await createSandbox({ config: { enabled: false } });
  t.after(() => sandbox.cleanup());

  await save(sandbox, { agent: "scout", model: "openai/gpt-6-sol", thinking: "high" });

  const config = await sandbox.readConfig();
  assert.equal(config.enabled, false, "enabled must not be flipped");
  assert.equal(config.agents.scout.model, "openai/gpt-6-sol");
});

test("does not create a config.json when the user cancels", async (t) => {
  const sandbox = await createSandbox();
  t.after(() => sandbox.cleanup());

  sandbox.state.queue = [undefined];
  await sandbox.command.handler("", sandbox.ctx);

  await assert.rejects(() => readFile(sandbox.configPath, "utf8"));
  assert.ok(sandbox.state.notifications.some((n) => n.message.startsWith("Cancelled")));
});

test("a broken config.json never becomes a broken write", async (t) => {
  silenceConsoleError(t);
  const sandbox = await createSandbox({ config: "" });
  t.after(() => sandbox.cleanup());

  await sandbox.command.handler("", sandbox.ctx);

  assert.equal(sandbox.state.selects.length, 0);
  assert.equal(await sandbox.readConfigText(), "");
  assert.deepEqual(await readdir(sandbox.dir).then((f) => f.filter((n) => n.endsWith(".tmp"))), []);
});
