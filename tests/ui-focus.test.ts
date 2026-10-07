import { readFile } from "node:fs/promises";
import { Script, createContext, runInContext } from "node:vm";
import { expect, test } from "vitest";

test("the graph opens the failed node but respects a later manual selection", async () => {
  const app = { innerHTML: "", addEventListener() {} };
  const api = { onChanged() {}, snapshot: () => new Promise(() => {}), ready() {} };
  const context = createContext({ window: { moderaPlugin: api }, document: { getElementById: () => app, documentElement: { style: { setProperty() {} } } } });
  new Script(await readFile(new URL("../ui/main.js", import.meta.url), "utf8")).runInContext(context);
  const steps = [
    { id: "first", title: "First", instruction: "Do first", kind: "task", state: "completed", dependsOn: [] },
    { id: "failed", title: "Broken step", instruction: "Fix it", kind: "task", state: "failed", dependsOn: ["first"], target: { sessionId: "session" }, runId: "run" },
  ];
  const view = { data: { active: { id: "flow", title: "Flow", state: "failed", steps }, flows: [], outcome: "failed" } };
  (context as { testView?: unknown }).testView = view;
  runInContext("snapshot = { view: testView }; render()", context);
  expect(app.innerHTML).toContain('class="step-card failed selected"');
  expect(app.innerHTML).toContain("在原会话继续此步骤");
  runInContext('selectedStepId = "first"; render()', context);
  expect(app.innerHTML).toContain('class="step-card completed selected"');
  expect(app.innerHTML).not.toContain("在原会话继续此步骤");
});
