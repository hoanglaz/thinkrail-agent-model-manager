import { test } from "node:test";
import assert from "node:assert/strict";

import { baseConfig, createSandbox, MODELS, pickStartsWith } from "./helpers.mjs";

/** Runs the command with the given dialog answers and asserts nothing was written. */
async function expectNoWrite(t, answers) {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  const before = await sandbox.readConfigText();

  sandbox.state.available = MODELS;
  sandbox.state.queue = answers;
  await sandbox.command.handler("", sandbox.ctx);

  assert.equal(await sandbox.readConfigText(), before, "config.json must be untouched");
  const cancelled = sandbox.state.notifications.find((n) =>
    n.message.startsWith("Cancelled")
  );
  assert.ok(cancelled, "a cancellation notice is expected");
  assert.equal(cancelled.type, "info");
  assert.ok(
    !sandbox.state.notifications.some((n) => n.message.startsWith("Saved")),
    "nothing may be reported as saved"
  );
  assert.deepEqual(
    (await sandbox.listDir()).filter((name) => name.endsWith(".tmp")),
    []
  );
  return sandbox;
}

test("cancelling the agent selector changes nothing", async (t) => {
  await expectNoWrite(t, [undefined]);
});

test("cancelling the model selector changes nothing", async (t) => {
  await expectNoWrite(t, [pickStartsWith("scout —"), undefined]);
});

test("cancelling the thinking selector changes nothing", async (t) => {
  await expectNoWrite(t, [
    pickStartsWith("scout —"),
    pickStartsWith("openai/gpt-6-sol"),
    undefined
  ]);
});

test("declining the confirmation changes nothing", async (t) => {
  const sandbox = await expectNoWrite(t, [
    pickStartsWith("worker"),
    pickStartsWith("openai/gpt-6-luna"),
    pickStartsWith("off"),
    false
  ]);
  assert.equal(sandbox.state.confirms.length, 1, "the confirmation was shown");
});

test("a cancellation never leaves a partially written file", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  const before = await sandbox.readConfigText();

  sandbox.state.available = MODELS;
  sandbox.state.queue = [pickStartsWith("reviewer"), pickStartsWith("openai/gpt-6-luna"), undefined];
  await sandbox.command.handler("", sandbox.ctx);

  assert.equal(await sandbox.readConfigText(), before);
  const parsed = await sandbox.readConfig();
  assert.equal(parsed.agents.reviewer.model, "openai/gpt-6-sol");
  assert.equal(parsed.agents.reviewer.thinking, "high");
});

test("cancelling twice in a row still writes nothing", async (t) => {
  const sandbox = await createSandbox({ config: baseConfig() });
  t.after(() => sandbox.cleanup());
  const before = await sandbox.readConfigText();
  sandbox.state.available = MODELS;

  sandbox.state.queue = [undefined];
  await sandbox.command.handler("", sandbox.ctx);
  sandbox.state.queue = [pickStartsWith("scout —"), undefined];
  await sandbox.command.handler("", sandbox.ctx);

  assert.equal(await sandbox.readConfigText(), before);
  assert.equal(
    sandbox.state.notifications.filter((n) => n.message.startsWith("Cancelled")).length,
    2
  );
});
