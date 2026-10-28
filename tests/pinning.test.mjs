import { test } from "node:test";
import assert from "node:assert/strict";

import { baseConfig, createSandbox, silenceConsoleError } from "./helpers.mjs";

/** Calls the tool_call hook with a fresh Agent call and returns the mutated input. */
function agentCall(sandbox, subagentType) {
  const event = { toolName: "Agent", input: { subagent_type: subagentType } };
  sandbox.toolCallHook(event);
  return event.input;
}

test("registers a tool_call hook", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  assert.equal(typeof sandbox.toolCallHook, "function");
});

test("pins the configured model and thinking level for each agent", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  assert.equal(agentCall(sandbox, "scout").model, "openai/gpt-6-luna:low");
  assert.equal(agentCall(sandbox, "planner").model, "openai/gpt-6-sol:high");
  assert.equal(agentCall(sandbox, "worker").model, "openai/gpt-6-sol:medium");
  assert.equal(agentCall(sandbox, "reviewer").model, "openai/gpt-6-sol:high");
});

test("omits the thinking suffix when no level is configured", async (t) => {
  const sandbox = await createSandbox({
    config: { enabled: true, agents: { scout: { model: "openai/gpt-6-luna" } } }
  });
  t.after(() => sandbox.cleanup());

  assert.equal(agentCall(sandbox, "scout").model, "openai/gpt-6-luna");
});

test("re-reads config.json on every call", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  assert.equal(agentCall(sandbox, "worker").model, "openai/gpt-6-sol:medium");

  const updated = baseConfig();
  updated.agents.worker = { model: "openai/gpt-6-luna", thinking: "off" };
  await sandbox.writeConfig(updated);

  assert.equal(agentCall(sandbox, "worker").model, "openai/gpt-6-luna:off");
});

test("a pin written by the command takes effect immediately", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  sandbox.state.available = [
    { provider: "openai", id: "gpt-6-luna" },
    { provider: "openai", id: "gpt-6-sol" }
  ];
  sandbox.state.queue = [
    (options) => options.find((option) => option.startsWith("scout —")),
    (options) => options.find((option) => option === "openai/gpt-6-sol"),
    (options) => options.find((option) => option.startsWith("xhigh")),
    true
  ];
  await sandbox.command.handler("", sandbox.ctx);

  assert.equal(agentCall(sandbox, "scout").model, "openai/gpt-6-sol:xhigh");
});

test("ignores tools other than Agent", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  const event = { toolName: "read", input: { path: "x" } };
  sandbox.toolCallHook(event);

  assert.deepEqual(event.input, { path: "x" });
});

test("ignores an agent that is not configured", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());

  assert.equal(agentCall(sandbox, "unknown-agent").model, undefined);
  assert.equal(agentCall(sandbox, undefined).model, undefined);
});

test("ignores an agent entry without a model", async (t) => {
  const sandbox = await createSandbox({
    config: { enabled: true, agents: { scout: { thinking: "low" } } }
  });
  t.after(() => sandbox.cleanup());

  assert.equal(agentCall(sandbox, "scout").model, undefined);
});

test("does nothing while the extension is disabled", async (t) => {
  const config = baseConfig();
  config.enabled = false;
  const sandbox = await createSandbox({ config });
  t.after(() => sandbox.cleanup());

  assert.equal(agentCall(sandbox, "scout").model, undefined);
});

test("does nothing when config.json is missing", async (t) => {
  silenceConsoleError(t);
  const sandbox = await createSandbox();
  t.after(() => sandbox.cleanup());

  assert.equal(agentCall(sandbox, "scout").model, undefined);
});

test("does nothing when config.json is invalid", async (t) => {
  silenceConsoleError(t);
  const sandbox = await createSandbox({ config: "{ broken" });
  t.after(() => sandbox.cleanup());

  assert.equal(agentCall(sandbox, "scout").model, undefined);
});

test("skips a thinking level that is not one of the seven", async (t) => {
  silenceConsoleError(t);
  const sandbox = await createSandbox({
    config: { enabled: true, agents: { scout: { model: "openai/gpt-6-luna", thinking: "bogus" } } }
  });
  t.after(() => sandbox.cleanup());

  assert.equal(agentCall(sandbox, "scout").model, undefined);
});

test("does not overwrite an invocation model when the agent is not pinned", async (t) => {
  const sandbox = await createSandbox({ config: { enabled: true, agents: {} } });
  t.after(() => sandbox.cleanup());

  const event = { toolName: "Agent", input: { subagent_type: "scout", model: "deepseek/deepseek-v4.1-flash" } };
  sandbox.toolCallHook(event);

  assert.equal(event.input.model, "deepseek/deepseek-v4.1-flash");
});
