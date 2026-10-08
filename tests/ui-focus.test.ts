import { readFile } from "node:fs/promises";
import { Script, createContext, runInContext } from "node:vm";
import { expect, test } from "vitest";

test("the graph opens the failed node but respects a later manual selection", async () => {
  const app = { innerHTML: "", addEventListener() {} };
  const api = { onChanged() {}, snapshot: () => new Promise(() => {}), ready() {} };
  const context = createContext({ window: { moderaPlugin: api }, document: { getElementById: () => app, documentElement: { style: { setProperty() {} } } } });
  new Script(await readFile(new URL("../ui/main.js", import.meta.url), "utf8")).runInContext(context);
  const steps = [
    { id: "first", title: "First", instruction: "Do first", kind: "task", state: "completed", dependsOn: [], handoff: "Checked files" },
    { id: "failed", title: "Broken step", instruction: "Fix it", kind: "task", state: "failed", dependsOn: ["first"], target: { sessionId: "session" }, runId: "run" },
  ];
  const view = { data: { active: { id: "flow", title: "Flow", state: "failed", steps }, flows: [], outcome: "failed" } };
  (context as { testView?: unknown }).testView = view;
  runInContext("snapshot = { view: testView }; render()", context);
  expect(app.innerHTML).toContain('class="step-card failed selected"');
  expect(app.innerHTML).toContain("在原会话继续此步骤");
  runInContext('selectedStepId = "first"; render()', context);
  expect(app.innerHTML).toContain('class="step-card completed selected"');
  expect(app.innerHTML).toContain("给后续步骤的交接摘要");
  expect(app.innerHTML).not.toContain("在原会话继续此步骤");
  view.data.active.state = "paused";
  steps[1]!.kind = "approval";
  steps[1]!.state = "awaitingApproval";
  runInContext("render()", context);
  expect(app.innerHTML).toContain('class="step-card awaitingApproval selected"');
  expect(app.innerHTML).toContain("已检查");
  runInContext('selectedStepId = "first"; render()', context);
  expect(app.innerHTML).toContain('class="step-card completed selected"');
});

test("inline workflow shows its dependency graph and execution decision without the project sidebar", async () => {
  const app = { innerHTML: "", addEventListener() {} };
  const context = createContext({ window: { moderaPlugin: { onChanged() {}, snapshot: () => new Promise(() => {}), ready() {} } }, document: { getElementById: () => app, documentElement: { style: { setProperty() {} } } } });
  new Script(await readFile(new URL("../ui/main.js", import.meta.url), "utf8")).runInContext(context);
  const flow = { id: "flow", title: "Todo", state: "draft", steps: [
    { id: "a", title: "Implement", instruction: "Build app", kind: "task", state: "pending", dependsOn: [] },
    { id: "b", title: "Verify", instruction: "Check app", kind: "task", state: "pending", dependsOn: ["a"] },
  ] };
  (context as { testView?: unknown }).testView = { data: { mode: "inline", active: flow } };
  runInContext("snapshot = { view: testView }; render()", context);
  expect(app.innerHTML).toContain('class="edges"');
  expect(app.innerHTML).toContain('data-action="start" data-value="flow"');
  expect(app.innerHTML).toContain("允许执行");
  expect(app.innerHTML).not.toContain('class="sidebar"');
  flow.state = "running";
  flow.steps[0]!.state = "running";
  runInContext("render()", context);
  expect(app.innerHTML).toContain('class="step-card running selected"');
  expect(app.innerHTML).not.toContain("运行此工作流？");
});
