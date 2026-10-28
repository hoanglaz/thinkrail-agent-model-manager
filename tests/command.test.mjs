import { test } from "node:test";
import assert from "node:assert/strict";

import { baseConfig, createSandbox, MODELS, pickIncludes, pickStartsWith } from "./helpers.mjs";

const SORTED_MODELS = [
  "deepseek/deepseek-v4.1-flash",
  "openai/gpt-6-luna",
  "openai/gpt-6-sol"
];

const THINKING_OPTIONS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

test("registers the /agent-models command with a description", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  assert.ok(sandbox.command, "the command must be registered");
  assert.equal(typeof sandbox.command.handler, "function");
  assert.ok(sandbox.command.description.length > 0);
});

test("lists the four built-in agents with their current pin", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  sandbox.state.queue = [undefined];

  await sandbox.command.handler("", sandbox.ctx);

  assert.deepEqual(sandbox.state.selects[0].options, [
    "scout — openai/gpt-6-luna (thinking: low)",
    "planner — openai/gpt-6-sol (thinking: high)",
    "worker — openai/gpt-6-sol (thinking: medium)",
    "reviewer — openai/gpt-6-sol (thinking: high)"
  ]);
});

test("says so when an agent has no pin yet", async (t) => {
  const sandbox = await createSandbox({ config: { enabled: true, agents: {} } });
  t.after(() => sandbox.cleanup());
  sandbox.state.queue = [undefined];

  await sandbox.command.handler("", sandbox.ctx);

  assert.deepEqual(sandbox.state.selects[0].options, [
    "scout — no model configured",
    "planner — no model configured",
    "worker — no model configured",
    "reviewer — no model configured"
  ]);
});

test("appends agents that only exist in config.json, sorted", async (t) => {
  const config = baseConfig();
  config.agents.zeta = { model: "openai/gpt-6-luna", thinking: "low" };
  config.agents.alpha = { model: "openai/gpt-6-luna", thinking: "low" };
  const sandbox = await createSandbox({ config });
  t.after(() => sandbox.cleanup());
  sandbox.state.queue = [undefined];

  await sandbox.command.handler("", sandbox.ctx);

  const names = sandbox.state.selects[0].options.map((option) => option.split(" — ")[0]);
  assert.deepEqual(names, ["scout", "planner", "worker", "reviewer", "alpha", "zeta"]);
});

test("sorts and de-duplicates the model list by provider then id", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = MODELS;
  sandbox.state.queue = [pickStartsWith("scout —"), undefined];

  await sandbox.command.handler("", sandbox.ctx);

  assert.deepEqual(sandbox.state.selects[1].options, SORTED_MODELS);
});

test("tolerates malformed entries from the model registry", async (t) => {
  const sandbox = await createSandbox({ config: { enabled: true, agents: {} } });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = [null, 42, {}, { provider: "openai" }, { id: "x" }, { provider: "", id: "y" }, { provider: "z", id: "ok" }];
  sandbox.state.queue = [pickStartsWith("scout —"), undefined];

  await sandbox.command.handler("", sandbox.ctx);

  assert.deepEqual(sandbox.state.selects[1].options, ["z/ok"]);
});

test("appends the pinned model when it is not available, clearly labelled", async (t) => {
  const config = baseConfig();
  config.agents.scout = { model: "openai/gpt-6-astra", thinking: "max" };
  const sandbox = await createSandbox({ config });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = MODELS;
  sandbox.state.queue = [pickStartsWith("scout —"), undefined];

  await sandbox.command.handler("", sandbox.ctx);

  const options = sandbox.state.selects[1].options;
  assert.deepEqual(options.slice(0, SORTED_MODELS.length), SORTED_MODELS);
  assert.equal(options.length, SORTED_MODELS.length + 1);
  assert.equal(options.at(-1), "openai/gpt-6-astra  (currently pinned — not in the available list)");
});

test("does not duplicate the pinned model when it is available", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = MODELS;
  sandbox.state.queue = [pickStartsWith("scout —"), undefined];

  await sandbox.command.handler("", sandbox.ctx);

  assert.deepEqual(sandbox.state.selects[1].options, SORTED_MODELS);
});

test("offers the seven thinking levels and marks the current one", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = MODELS;
  sandbox.state.queue = [pickStartsWith("worker —"), pickStartsWith("openai/gpt-6-sol"), undefined];

  await sandbox.command.handler("", sandbox.ctx);

  assert.deepEqual(sandbox.state.selects[2].options, [
    "off",
    "minimal",
    "low",
    "medium  (current)",
    "high",
    "xhigh",
    "max"
  ]);
});

test("shows the agent, the previous pin and the new pin in the confirmation", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = MODELS;
  sandbox.state.queue = [pickStartsWith("scout —"), pickStartsWith("openai/gpt-6-sol"), pickStartsWith("high"), false];

  await sandbox.command.handler("", sandbox.ctx);

  const { title, message } = sandbox.state.confirms[0];
  assert.equal(title, "Save scout?");
  assert.match(message, /Agent: {4}scout/);
  assert.match(message, /Previous: openai\/gpt-6-luna \(thinking: low\)/);
  assert.match(message, /New: {6}openai\/gpt-6-sol \(thinking: high\)/);
  assert.ok(message.includes(sandbox.configPath), "the target path should be shown");
});

test("adds the request_review note only when the reviewer is edited", async (t) => {
  const reviewerSandbox = await createSandbox({ config: baseConfig() });
  t.after(() => reviewerSandbox.cleanup());
  reviewerSandbox.state.available = MODELS;
  reviewerSandbox.state.queue = [pickStartsWith("reviewer"), pickStartsWith("openai/gpt-6-sol"), pickStartsWith("high"), false];
  await reviewerSandbox.command.handler("", reviewerSandbox.ctx);

  const workerSandbox = await createSandbox({ config: baseConfig() });
  t.after(() => workerSandbox.cleanup());
  workerSandbox.state.available = MODELS;
  workerSandbox.state.queue = [pickStartsWith("worker"), pickStartsWith("openai/gpt-6-sol"), pickStartsWith("high"), false];
  await workerSandbox.command.handler("", workerSandbox.ctx);

  assert.match(reviewerSandbox.state.confirms[0].message, /request_review ignores this file/);
  assert.doesNotMatch(workerSandbox.state.confirms[0].message, /request_review/);
});

test("notifies the saved pin on success", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = MODELS;
  sandbox.state.queue = [pickStartsWith("scout —"), pickStartsWith("openai/gpt-6-sol"), pickStartsWith("xhigh"), true];

  await sandbox.command.handler("", sandbox.ctx);

  const success = sandbox.state.notifications.find((n) => n.type === "info" && n.message.startsWith("Saved"));
  assert.ok(success, "a success notification is expected");
  assert.equal(
    success.message,
    "Saved scout → openai/gpt-6-sol (thinking: xhigh). New subagent spawns pick this up immediately."
  );
});

test("warns and aborts when no model is available and none is pinned", async (t) => {
  const sandbox = await createSandbox({ config: { enabled: true, agents: {} } });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = [];
  sandbox.state.queue = [pickStartsWith("scout —")];

  await sandbox.command.handler("", sandbox.ctx);

  const warning = sandbox.state.notifications.find((n) => n.type === "warning");
  assert.ok(warning);
  assert.match(warning.message, /No models are available/);
  assert.equal(sandbox.state.selects.length, 1, "the model selector must not open");
});

test("offers only the pinned model when nothing else is available", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = [];
  sandbox.state.queue = [pickStartsWith("scout —"), undefined];

  await sandbox.command.handler("", sandbox.ctx);

  assert.deepEqual(sandbox.state.selects[1].options, [
    "openai/gpt-6-luna  (currently pinned — not in the available list)"
  ]);
});

test("reports a model registry that throws", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  sandbox.ctx.modelRegistry.getAvailable = () => {
    throw new Error("registry offline");
  };
  sandbox.state.queue = [pickStartsWith("scout —")];

  await sandbox.command.handler("", sandbox.ctx);

  const error = sandbox.state.notifications.find((n) => n.type === "error");
  assert.ok(error);
  assert.match(error.message, /registry offline/);
});

test("never writes a model reference with a thinking suffix", async (t) => {
  const config = baseConfig();
  config.agents.scout = { model: "openai/gpt-6-sol:high", thinking: "high" };
  const sandbox = await createSandbox({ config });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = MODELS;
  sandbox.state.queue = [pickStartsWith("scout —"), pickStartsWith("openai/gpt-6-sol"), pickStartsWith("medium"), true];

  await sandbox.command.handler("", sandbox.ctx);

  const saved = await sandbox.readConfig();
  assert.equal(saved.agents.scout.model, "openai/gpt-6-sol");
  assert.equal(saved.agents.scout.thinking, "medium");
});

test("strips the suffix when the pinned model is re-selected as unavailable", async (t) => {
  const config = baseConfig();
  config.agents.scout = { model: "openai/gpt-6-astra:max", thinking: "max" };
  const sandbox = await createSandbox({ config });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = MODELS;
  sandbox.state.queue = [pickStartsWith("scout —"), pickIncludes("currently pinned"), pickStartsWith("low"), true];

  await sandbox.command.handler("", sandbox.ctx);

  const saved = await sandbox.readConfig();
  assert.equal(saved.agents.scout.model, "openai/gpt-6-astra");
  assert.equal(saved.agents.scout.thinking, "low");
});

test("a model id containing a colon is not mistaken for a thinking suffix", async (t) => {
  const config = baseConfig();
  config.agents.scout = { model: "amazon/nova-2-lite-v1:0", thinking: "low" };
  const sandbox = await createSandbox({ config });
  t.after(() => sandbox.cleanup());
  sandbox.state.available = [{ provider: "amazon", id: "nova-2-lite-v1:0" }];
  sandbox.state.queue = [pickStartsWith("scout —"), undefined];

  await sandbox.command.handler("", sandbox.ctx);

  assert.deepEqual(sandbox.state.selects[1].options, ["amazon/nova-2-lite-v1:0"]);
});
