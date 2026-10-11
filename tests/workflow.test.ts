import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import type { PluginContext, ToolContext, PluginContributions } from "@modera/plugin-sdk";
import { activate } from "../src/index";
import manifest from "../plugin.json";

// These persisted-flow fixtures simulate the host binding a tool result to its card.
function fixtureResultCard(contributions: PluginContributions | void, root: string) {
  const card = contributions?.ui?.find(item => item.id === "modera.workflow.result");
  if (!card) return undefined;
  return { ...card, async render(request: Parameters<typeof card.render>[0], context: ToolContext) {
    const stored = JSON.parse(await readFile(join(root, "flows.json"), "utf8")) as { flows: { id: string }[] };
    return card.render({ ...request, tool: request.tool ?? { name: "workflow_draft", input: "{}", result: JSON.stringify({ flowId: stored.flows[0]?.id }) } }, context);
  } };
}
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

test("the inline graph is bound to its tool result and can execute without opening the workbench", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-inline-"));
  roots.push(root);
  let background: Promise<void> | undefined;
  const started: string[] = [];
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ models: [{ profileId: "local", name: "Local", models: ["test"] }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object, title: string) => ({ ...target, sessionId: title }),
      startRole: async (_target: unknown, role: { name: string }) => { started.push(role.name); return { runId: role.name }; },
      inspect: async () => ({ outcome: "completed" }), result: async () => ({ outcome: "completed", text: "Done" }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  expect(manifest.extensions).toEqual(["tool.result"]);
  expect(contributions!.ui!.map(item => item.slot)).toEqual(manifest.extensions);
  expect(manifest.contributions).toContain("composer");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const raw = { title: "Inline", steps: [{ title: "Build", instruction: "Build app" }, { title: "Verify", instruction: "Check app" }] };
  const result = await contributions!.tools![0]!.execute(raw, context) as { flowId: string };
  await contributions!.tools![0]!.execute({ ...raw, title: "Other flow" }, context);
  const card = contributions!.ui!.find(item => item.id === "modera.workflow.result")!;
  expect(card.frontend).toBe("workbench");
  const request = { id: card.id, projectId: "project", sessionId: "chat", locale: "zh-CN", tool: { name: "workflow_draft", input: JSON.stringify(raw), result: JSON.stringify(result) } };
  const before = await card.render!(request, context);
  expect(before.data).toMatchObject({ mode: "inline", active: { id: result.flowId, title: "Inline", state: "draft" } });
  expect(started).toEqual([]);
  await card.act!({ id: "start", value: result.flowId }, context, request);
  await background;
  expect(started).toEqual(["Build", "Verify"]);
  expect((await card.render!(request, context)).data).toMatchObject({ active: { state: "completed" } });
});

test("a ten-step draft is accepted and an eleventh step is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-ten-steps-"));
  roots.push(root);
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ models: [] }), target() {}, prepare() {}, startRole() {}, inspect() {}, result() {},
  } } as unknown as PluginContext;
  const contributions = await activate(host);
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const tool = contributions?.tools?.[0];
  if (!tool) throw new Error("Workflow draft tool missing");
  const steps = Array.from({ length: 10 }, (_, index) => ({ title: `Step ${index + 1}`, instruction: `Do ${index + 1}`, ...(index === 9 ? { after: [1, 2, 3, 4, 5, 6, 7, 8, 9] } : {}) }));
  await tool.execute({ title: "Ten steps", steps }, context);
  const saved = JSON.parse(await readFile(join(root, "flows.json"), "utf8")) as { flows: { steps: unknown[] }[] };
  expect(saved.flows[0]?.steps).toHaveLength(10);
  await expect(tool.execute({ title: "Too many", steps: [...steps, { title: "Step 11", instruction: "Do 11" }] }, context)).rejects.toThrow("2–10");
});

test("opening a restarted workflow restores exact completed nodes and leaves uncertain nodes for review", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-reopen-"));
  roots.push(root);
  await writeFile(join(root, "flows.json"), JSON.stringify({ version: 1, flows: [{ id: "flow", projectId: "project", title: "Recover", state: "running", createdAt: 1, steps: [
    { id: "a", title: "A", instruction: "Do A", dependsOn: [], state: "running", target: { projectId: "project", sessionId: "session-a" }, runId: "run-a" },
    { id: "b", title: "B", instruction: "Do B", dependsOn: [], state: "running", target: { projectId: "project", sessionId: "session-b" }, runId: "run-b" },
  ] }] }));
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ models: [] }), target() {}, prepare() {}, startRole() {},
    inspect: async (_target: unknown, runId: string) => ({ outcome: runId === "run-a" ? "completed" : "unknown", busy: false }),
    result: async (_target: unknown, runId: string) => ({ outcome: "completed", text: `Restored ${runId}` }),
  } } as unknown as PluginContext;
  const workbench = fixtureResultCard(await activate(host), root);
  if (!workbench?.render) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const firstView = await workbench.render({ id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" }, context);
  expect(JSON.stringify(firstView.children)).toContain("B · 待核实");
  const saved = JSON.parse(await readFile(join(root, "flows.json"), "utf8"));
  expect(saved.flows[0].state).toBe("interrupted");
  expect(saved.flows[0].steps[0]).toMatchObject({ state: "completed", result: "Restored run-a" });
  expect(saved.flows[0].steps[1].state).toBe("running");
  const settledHost = { ...host, scheduling: { ...host.scheduling, inspect: async () => ({ outcome: "completed", busy: false }) } } as unknown as PluginContext;
  const settled = fixtureResultCard(await activate(settledHost), root);
  if (!settled?.render) throw new Error("Workflow workbench missing after restart");
  await settled.render({ id: settled.id, sessionId: "", projectId: "project", locale: "zh-CN" }, context);
  const completed = JSON.parse(await readFile(join(root, "flows.json"), "utf8"));
  expect(completed.flows[0].state).toBe("completed");
  expect(completed.flows[0].steps[1]).toMatchObject({ state: "completed", result: "Restored run-b" });
});

test("restart restores a completed parallel task and waits for its approval without retrying", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-approval-restart-"));
  roots.push(root);
  await writeFile(join(root, "flows.json"), JSON.stringify({ version: 1, flows: [{
    id: "flow", projectId: "project", title: "Release", state: "running", createdAt: 1, steps: [
      { id: "review", title: "Human review", instruction: "Review", kind: "approval", state: "awaitingApproval", dependsOn: [] },
      { id: "check", title: "Independent check", instruction: "Check", state: "completed", result: "checked", dependsOn: [] },
      { id: "publish", title: "Publish", instruction: "Publish", state: "pending", selection: { profileId: "missing", model: "old", reasoningEffort: "medium" }, dependsOn: ["review", "check"] },
    ],
  }] }));
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
    target() {}, prepare() {}, startRole() {}, result() {}, inspect() {},
  } } as unknown as PluginContext;
  const workbench = fixtureResultCard(await activate(host), root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const view = await workbench.render({ id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" }, context);
  expect(view.data?.active).toMatchObject({ state: "paused" });
  expect(JSON.stringify(view.children)).toContain("已检查「Human review」，继续工作流");
  expect(JSON.stringify(view.children)).not.toContain("在新会话重试未完成步骤");
  expect((JSON.parse(await readFile(join(root, "flows.json"), "utf8")) as { flows: { state: string }[] }).flows[0]!.state).toBe("paused");
  const modelSelect = view.children.find(node => node.type === "select" && node.action === "setModel");
  if (modelSelect?.type !== "select") throw new Error("Paused model selector missing");
  expect(modelSelect.options.some(option => option.label === "当前选择已不可用")).toBe(true);
  await workbench.act({ id: "setModel", value: JSON.stringify({ context: modelSelect.context, value: JSON.stringify(["local", "test"]) }) }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" });
  const saved = JSON.parse(await readFile(join(root, "flows.json"), "utf8")) as { flows: { steps: { selection?: { model: string } }[] }[] };
  expect(saved.flows[0]!.steps[2]!.selection?.model).toBe("test");
});

test("a replaced run cannot become a completed step through a stale result read or ordinary retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-stale-result-"));
  roots.push(root);
  await writeFile(join(root, "flows.json"), JSON.stringify({ version: 1, flows: [{ id: "flow", projectId: "project", title: "Recover", state: "failed", createdAt: 1, steps: [
    { id: "a", title: "A", instruction: "Do A", state: "failed", target: { projectId: "project", sessionId: "session-a" }, runId: "old-run" },
    { id: "b", title: "B", instruction: "Do B", state: "pending" },
  ] }] }));
  let starts = 0;
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
    target() {}, prepare() {}, startRole: async () => { starts++; return { runId: "new-run" }; },
    inspect: async (_target: unknown, runId?: string) => ({ outcome: runId ? "completed" : "unknown", busy: false }),
    result: async () => ({ outcome: "unknown", text: "" }),
  } } as unknown as PluginContext;
  const workbench = fixtureResultCard(await activate(host), root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  await expect(workbench.act({ id: "retry", value: "flow" }, context, request)).rejects.toThrow("结果已变化或无法确认");
  expect(starts).toBe(0);
  const saved = JSON.parse(await readFile(join(root, "flows.json"), "utf8"));
  expect(saved.flows[0].steps[0].state).toBe("failed");
  expect(saved.flows[0].steps[0].result).toBeUndefined();
});

test("a result replaced between inspect and read stops downstream execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-result-race-"));
  roots.push(root);
  let background: Promise<void> | undefined;
  const started: string[] = [];
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object, title: string) => ({ ...target, sessionId: title }),
      startRole: async (_target: unknown, role: { name: string }) => { started.push(role.name); return { runId: role.name }; },
      inspect: async () => ({ outcome: "completed" }),
      result: async () => ({ outcome: "unknown", text: "" }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const workbench = fixtureResultCard(contributions, root);
  if (!workbench?.act || !contributions?.tools) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const created = await contributions.tools[0]!.execute({ title: "Race", steps: [{ title: "A", instruction: "Do A" }, { title: "B", instruction: "Do B" }] }, context) as { flowId: string };
  await workbench.act({ id: "start", value: created.flowId }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" });
  await background;
  expect(started).toEqual(["A"]);
  const saved = JSON.parse(await readFile(join(root, "flows.json"), "utf8"));
  expect(saved.flows[0].state).toBe("failed");
  expect(saved.flows[0].steps[0].state).toBe("failed");
  expect(saved.flows[0].steps[0].result).toBeUndefined();
});

test("a failed step continues in its original conversation before downstream steps run", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-continue-"));
  roots.push(root);
  await writeFile(join(root, "flows.json"), JSON.stringify({ version: 1, flows: [{ id: "flow", projectId: "project", title: "Recover", state: "failed", createdAt: 1, steps: [
    { id: "a", title: "A", instruction: "Do A", state: "failed", target: { projectId: "project", sessionId: "original", selection: { profileId: "local", model: "test", reasoningEffort: "medium" } }, runId: "failed-run" },
    { id: "b", title: "B", instruction: "Do B", state: "pending" },
  ] }] }));
  const continued: string[] = [];
  const started: string[] = [];
  const backgrounds: Promise<void>[] = [];
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { backgrounds.push(task(new AbortController().signal)); },
    scheduling: {
      options: async () => ({ models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object, title: string) => ({ ...target, sessionId: title }),
      continueRole: async (target: { sessionId: string }, previous: string, prompt: string) => { continued.push(`${target.sessionId}:${previous}:${prompt}`); return { runId: "continued-run" }; },
      startRole: async (_target: unknown, role: { name: string }) => { started.push(role.name); return { runId: "downstream-run" }; },
      inspect: async (_target: unknown, runId: string) => ({ outcome: runId === "failed-run" ? "failed" : "completed", busy: false }),
      result: async (_target: unknown, runId: string) => ({ outcome: "completed", text: `result ${runId}` }),
    },
  } as unknown as PluginContext;
  const workbench = fixtureResultCard(await activate(host), root);
  if (!workbench?.act) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  await workbench.act({ id: "continueFailed", value: JSON.stringify({ context: JSON.stringify({ flowId: "flow", stepId: "a" }), text: "Fix the failure" }) }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" });
  for (let index = 0; index < backgrounds.length; index++) await backgrounds[index];
  expect(continued).toHaveLength(1);
  expect(continued[0]).toContain("original:failed-run:Fix the failure");
  expect(continued[0]).toContain("<handoff>交接内容</handoff>");
  expect(started).toEqual(["B"]);
  const saved = JSON.parse(await readFile(join(root, "flows.json"), "utf8"));
  expect(saved.flows[0].state).toBe("completed");
  expect(saved.flows[0].steps[0].target.sessionId).toBe("original");
  expect(saved.flows[0].steps[0].runId).toBe("continued-run");
});

test("independent workflow steps start together and a join waits for both results", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-graph-"));
  roots.push(root);
  const started: string[] = [];
  const prompts = new Map<string, string>();
  const rolePrompts = new Map<string, string>();
  let releasePair!: () => void;
  const pair = new Promise<void>(resolve => { releasePair = resolve; });
  let background: Promise<void> | undefined;
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object, title: string) => ({ ...target, sessionId: title }),
      startRole: async (_target: unknown, role: { name: string; prompt: string }, prompt: string) => { prompts.set(role.name, prompt); rolePrompts.set(role.name, role.prompt); started.push(role.name); if (started.length === 2) releasePair(); if (role.name !== "Join") await pair; return { runId: role.name }; },
      inspect: async () => ({ outcome: "completed" }), result: async (_target: unknown, runId: string) => ({ outcome: "completed", text: `result ${runId}` }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const workbench = fixtureResultCard(contributions, root);
  if (!workbench?.act || !workbench.render || !contributions?.tools) throw new Error("Workflow contributions missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const created = await contributions.tools[0]!.execute({ title: "Parallel", steps: [
    { title: "A", instruction: "Do A" }, { title: "B", instruction: "Do B" }, { title: "Join", instruction: "Combine" },
  ] }, context) as { flowId: string };
  const saved = JSON.parse(await readFile(join(root, "flows.json"), "utf8")) as { flows: { steps: { id: string }[] }[] };
  const [a, b, joined] = saved.flows[0]!.steps;
  const toggle = (stepId: string, prerequisiteId: string) => workbench.act!({ id: "toggleDependency", value: JSON.stringify({ flowId: created.flowId, stepId, prerequisiteId }) }, context, request);
  await toggle(b!.id, a!.id);
  await toggle(joined!.id, a!.id);
  await expect(toggle(a!.id, joined!.id)).rejects.toThrow("循环");
  await workbench.act({ id: "start", value: created.flowId }, context, request);
  await background;
  expect(started.slice(0, 2).sort()).toEqual(["A", "B"]);
  expect(started[2]).toBe("Join");
  expect(prompts.get("A")).not.toContain("前序步骤结果");
  expect(prompts.get("B")).not.toContain("前序步骤结果");
  expect(prompts.get("A")).toContain("同时运行的其他步骤也使用当前项目工作目录：B");
  expect(prompts.get("B")).toContain("同时运行的其他步骤也使用当前项目工作目录：A");
  expect(prompts.get("Join")).not.toContain("同时运行的其他步骤");
  expect(rolePrompts.get("A")).toContain("使用同一项目工作目录");
  expect(prompts.get("Join")).toContain("A:\nresult A");
  expect(prompts.get("Join")).toContain("B:\nresult B");
  const view = await workbench.render(request, context);
  expect(JSON.stringify(view.children)).toContain("已完成");
  expect(JSON.stringify(view.children)).toContain("前置步骤：A、B");
  expect(contributions.composer?.[0]?.description).toContain("步骤草稿");
});

test("a downstream step starts when its own prerequisite finishes while a sibling remains running", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-rolling-dag-"));
  roots.push(root);
  const started: string[] = [];
  const prompts = new Map<string, string>();
  let slowFinished = false;
  let background: Promise<void> | undefined;
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object, title: string) => ({ ...target, sessionId: title }),
      startRole: async (_target: unknown, role: { name: string }, prompt: string) => { started.push(role.name); prompts.set(role.name, prompt); return { runId: role.name }; },
      inspect: async (_target: unknown, runId: string) => ({ outcome: runId === "Slow B" && !slowFinished ? "running" : "completed" }),
      result: async (_target: unknown, runId: string) => ({ outcome: "completed", text: `${runId} done` }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const created = await contributions?.tools?.[0]?.execute({ title: "Rolling", steps: [
    { title: "Fast A", instruction: "Do A", after: [] },
    { title: "Slow B", instruction: "Do B", after: [] },
    { title: "After A", instruction: "Do C", after: [1] },
    { title: "Join", instruction: "Combine", after: [2, 3] },
  ] }, context) as { flowId: string };
  const workbench = fixtureResultCard(contributions, root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  await workbench.act({ id: "start", value: created.flowId }, context, request);
  try {
    for (let attempt = 0; attempt < 50 && !started.includes("After A"); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(started).toContain("After A");
    expect(started).not.toContain("Join");
    expect(prompts.get("After A")).toContain("同时运行的其他步骤也使用当前项目工作目录：Slow B");
  } finally {
    slowFinished = true;
    await background;
  }
  expect(started).toEqual(["Fast A", "Slow B", "After A", "Join"]);
  expect((await workbench.render(request, context)).data?.active).toMatchObject({ state: "completed" });
});

test("confirming an approval wakes its successor before an unrelated task finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-approval-wake-"));
  roots.push(root);
  const started: string[] = [];
  let slowFinished = false;
  let background: Promise<void> | undefined;
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object, title: string) => ({ ...target, sessionId: title }),
      startRole: async (_target: unknown, role: { name: string }) => { started.push(role.name); return { runId: role.name }; },
      inspect: async (_target: unknown, runId: string) => ({ outcome: runId === "Slow task" && !slowFinished ? "running" : "completed" }),
      result: async (_target: unknown, runId: string) => ({ outcome: "completed", text: `${runId} done` }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const created = await contributions?.tools?.[0]?.execute({ title: "Approval wake", steps: [
    { title: "Review", instruction: "Confirm", after: [] },
    { title: "Slow task", instruction: "Slow", after: [] },
    { title: "After review", instruction: "Continue", after: [1] },
  ] }, context) as { flowId: string };
  const stepId = (JSON.parse(await readFile(join(root, "flows.json"), "utf8")) as { flows: { steps: { id: string }[] }[] }).flows[0]!.steps[0]!.id;
  const workbench = fixtureResultCard(contributions, root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  await workbench.act({ id: "setStepKind", value: JSON.stringify({ context: JSON.stringify({ flowId: created.flowId, stepId }), value: "approval" }) }, context, request);
  await workbench.act({ id: "start", value: created.flowId }, context, request);
  try {
    for (let attempt = 0; attempt < 50 && !started.includes("Slow task"); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(started).toContain("Slow task");
    await workbench.act({ id: "approveStep", value: JSON.stringify({ flowId: created.flowId, stepId }) }, context, request);
    for (let attempt = 0; attempt < 50 && !started.includes("After review"); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(started).toContain("After review");
  } finally {
    slowFinished = true;
    await background;
  }
  expect((await workbench.render(request, context)).data?.active).toMatchObject({ state: "completed" });
});

test("a join receives every predecessor even when earlier results exceed the handoff budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-handoff-"));
  roots.push(root);
  let background: Promise<void> | undefined;
  const prompts = new Map<string, string>();
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object, title: string) => ({ ...target, sessionId: title }),
      startRole: async (_target: unknown, role: { name: string }, prompt: string) => { prompts.set(role.name, prompt); return { runId: role.name }; },
      inspect: async () => ({ outcome: "completed" }),
      result: async (_target: unknown, runId: string) => ({ outcome: "completed", text: runId === "A" ? `${"A_LOG".repeat(3000)}<handoff>A_SUMMARY with checked files</handoff>` : runId === "C" ? `C_SENTINEL${"C".repeat(12000)}` : runId.repeat(12000) }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const workbench = fixtureResultCard(contributions, root);
  if (!workbench?.act || !workbench.render || !contributions?.tools) throw new Error("Workflow contributions missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const created = await contributions.tools[0]!.execute({ title: "Join", steps: [
    { title: "A", instruction: "A", after: [] }, { title: "B", instruction: "B", after: [] },
    { title: "C", instruction: "C", after: [] }, { title: "Join", instruction: "Combine all", after: [1, 2, 3] },
  ] }, context) as { flowId: string };
  await workbench.act({ id: "start", value: created.flowId }, context, request);
  await background;
  const prompt = prompts.get("Join") ?? "";
  expect(prompt).toContain("A:\nA_SUMMARY with checked files");
  expect(prompt).not.toContain("A_LOG");
  expect(prompt).toContain("B:\n");
  expect(prompt).toContain("C:\nC_SENTINEL");
  expect(prompt).toContain("结果已截断");
  const saved = JSON.parse(await readFile(join(root, "flows.json"), "utf8"));
  expect(saved.flows[0].steps[0].resultTruncated).toBe(true);
  expect(saved.flows[0].steps[0].handoff).toBe("A_SUMMARY with checked files");
  expect(saved.flows[0].steps[0].result).not.toContain("<handoff>");
  const rendered = await workbench.render(request, context);
  expect(JSON.stringify(rendered.children)).toContain("此处只显示部分结果");
  expect(rendered.data?.active.steps[0]).toMatchObject({ handoff: "A_SUMMARY with checked files", resultTruncated: true });
});

test("workflow draft accepts explicit graph edges and rejects cycles before saving", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-draft-graph-"));
  roots.push(root);
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ models: [] }), target() {}, prepare() {}, startRole() {}, result() {}, inspect() {},
  } } as unknown as PluginContext;
  const tool = (await activate(host))?.tools?.[0];
  if (!tool) throw new Error("Workflow draft tool missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const steps = [
    { title: "A", instruction: "Do A", after: [] },
    { title: "B", instruction: "Do B", after: [] },
    { title: "Join", instruction: "Combine", after: [1, 2] },
  ];
  await tool.execute({ title: "Graph", steps }, context);
  const saved = JSON.parse(await readFile(join(root, "flows.json"), "utf8")) as { flows: { steps: { id: string; dependsOn: string[] }[] }[] };
  expect(saved.flows[0]!.steps[2]!.dependsOn).toEqual(saved.flows[0]!.steps.slice(0, 2).map(step => step.id));
  await expect(tool.execute({ title: "Cycle", steps: [{ ...steps[0], after: [3] }, steps[1], steps[2]] }, context)).rejects.toThrow("循环");
  expect((JSON.parse(await readFile(join(root, "flows.json"), "utf8")) as { flows: unknown[] }).flows).toHaveLength(1);
});

test("interrupted parallel run recovers every completed node before rerunning uncertain nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-parallel-recovery-"));
  roots.push(root);
  await writeFile(join(root, "flows.json"), JSON.stringify({ version: 1, flows: [{ id: "flow", projectId: "project", title: "Recover", state: "running", createdAt: 1, steps: [
    { id: "a", title: "A", instruction: "A", dependsOn: [], state: "running", target: { projectId: "project", sessionId: "old-a" }, runId: "run-a" },
    { id: "b", title: "B", instruction: "B", dependsOn: [], state: "running", target: { projectId: "project", sessionId: "old-b" }, runId: "run-b" },
    { id: "join", title: "Join", instruction: "Join", dependsOn: ["a", "b"], state: "pending" },
  ] }] }));
  const started: string[] = [];
  let background: Promise<void> | undefined;
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object, title: string) => ({ ...target, sessionId: title }),
      startRole: async (_target: unknown, role: { name: string }) => { started.push(role.name); return { runId: `new-${role.name}` }; },
      inspect: async (_target: unknown, runId?: string) => ({ outcome: runId === "run-b" ? "unknown" : "completed", busy: false }),
      result: async (_target: unknown, runId: string) => ({ outcome: "completed", text: `result ${runId}` }),
    },
  } as unknown as PluginContext;
  const workbench = fixtureResultCard(await activate(host), root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  await expect(workbench.act({ id: "retry", value: "flow" }, context, request)).rejects.toThrow("未能确认");
  await workbench.act({ id: "rerunUnknown", value: "flow" }, context, request);
  await background;
  expect(started).toEqual(["B", "Join"]);
  const view = await workbench.render(request, context);
  expect(JSON.stringify(view.children)).toContain("已完成");
  expect(JSON.stringify(view.children)).toContain("result run-a");
});

test("a tool draft keeps its workflow name separate from the first step", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-quick-draft-"));
  roots.push(root);
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ models: [] }), target() {}, prepare() {}, startRole() {}, result() {}, inspect() {},
  } } as unknown as PluginContext;
  const contributions = await activate(host);
  const workbench = fixtureResultCard(contributions, root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const draft = { title: "发布新版本", steps: [{ title: "安全检查", instruction: "安全检查" }, { title: "产品检查", instruction: "产品检查" }] };
  await contributions!.tools![0]!.execute(draft, context);
  const created = (await workbench.render(request, context)).data?.active as { title: string; steps: { title: string }[] };
  expect(created.title).toBe("发布新版本");
  expect(created.steps.map(step => step.title)).toEqual(["安全检查", "产品检查"]);
  await expect(contributions!.tools![0]!.execute({ ...draft, title: "" }, context)).rejects.toThrow("标题");
  await contributions!.tools![0]!.execute({ title: "设计", steps: [{ title: "设计", instruction: "设计" }, { title: "实现", instruction: "实现" }] }, context);
  expect((await workbench.render(request, context)).data?.active).toMatchObject({ title: "设计" });
  expect(workbench.actions).not.toContain("create");
});

test("result cards reopen older drafts by their tool result and remain project scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-pages-"));
  roots.push(root);
  await writeFile(join(root, "flows.json"), JSON.stringify({ version: 1, flows: Array.from({ length: 23 }, (_, index) => ({
    id: `flow-${index + 1}`, projectId: "project", title: `Flow ${index + 1}`, state: "draft", createdAt: index,
    steps: [{ id: `a-${index}`, title: `First ${index + 1}`, instruction: "First", state: "pending" }, { id: `b-${index}`, title: "Second", instruction: "Second", state: "pending" }],
  })) }));
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ models: [] }), target() {}, prepare() {}, startRole() {}, result() {}, inspect() {},
  } } as unknown as PluginContext;
  const workbench = fixtureResultCard(await activate(host), root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const first = await workbench.render(request, context);
  expect(first.data).toMatchObject({ mode: "inline", active: { id: "flow-1" } });
  expect(JSON.stringify(first.children)).toContain("Flow 1");
  expect(JSON.stringify(first.children)).not.toContain("Flow 23");
  const bound = { ...request, tool: { name: "workflow_draft", input: "{}", result: JSON.stringify({ flowId: "flow-23" }) } };
  const last = await workbench.render(bound, context);
  expect(last.data).toMatchObject({ mode: "inline", active: { id: "flow-23" } });
  expect(JSON.stringify(last.children)).toContain("First 23");
  expect(JSON.stringify(last.children)).not.toContain("Flow 1");
  expect((await workbench.render(bound, { ...context, projectId: "other" })).data?.active).toBeUndefined();
  expect(workbench.actions).not.toContain("showFlow");
  expect(workbench.actions).not.toContain("showPage");
});

test("inserting a step makes former successors wait and deleting it restores their dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-insert-"));
  roots.push(root);
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ models: [] }), target() {}, prepare() {}, startRole() {}, result() {}, inspect() {},
  } } as unknown as PluginContext;
  const contributions = await activate(host);
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const created = await contributions?.tools?.[0]?.execute({ title: "Release", steps: [
    { title: "Build", instruction: "Build", after: [] },
    { title: "Verify", instruction: "Verify", after: [1] },
    { title: "Publish", instruction: "Publish", after: [1] },
    { title: "Join", instruction: "Join", after: [2, 3] },
  ] }, context) as { flowId: string };
  const workbench = fixtureResultCard(contributions, root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const readSteps = async () => (JSON.parse(await readFile(join(root, "flows.json"), "utf8")) as { flows: { steps: { id: string; dependsOn: string[] }[] }[] }).flows[0]!.steps;
  const original = await readSteps();
  await workbench.act({ id: "addStep", value: JSON.stringify({ context: JSON.stringify({ flowId: created.flowId, stepId: original[0]!.id }), text: "Review" }) }, context, request);
  const inserted = await readSteps();
  expect(inserted[1]!.dependsOn).toEqual([original[0]!.id]);
  expect(inserted[2]!.dependsOn).toEqual([inserted[1]!.id]);
  expect(inserted[3]!.dependsOn).toEqual([inserted[1]!.id]);
  expect(inserted[4]!.dependsOn).toEqual([original[1]!.id, original[2]!.id]);
  const deletion = JSON.stringify({ flowId: created.flowId, stepId: inserted[1]!.id });
  await expect(workbench.act({ id: "deleteStep", value: deletion }, context, request)).rejects.toThrow("先查看删除影响");
  await workbench.act({ id: "requestDeleteStep", value: deletion }, context, request);
  expect(JSON.stringify((await workbench.render(request, context)).children)).toContain("2 个直接后续步骤将改为依赖它的前置步骤");
  await workbench.act({ id: "cancelDeleteStep", value: deletion }, context, request);
  await expect(workbench.act({ id: "deleteStep", value: deletion }, context, request)).rejects.toThrow("先查看删除影响");
  await workbench.act({ id: "requestDeleteStep", value: deletion }, context, request);
  await workbench.act({ id: "deleteStep", value: deletion }, context, request);
  const restored = await readSteps();
  expect(restored[1]!.dependsOn).toEqual([original[0]!.id]);
  expect(restored[2]!.dependsOn).toEqual([original[0]!.id]);
  expect(restored[3]!.dependsOn).toEqual([original[1]!.id, original[2]!.id]);
  await workbench.act({ id: "moveDown", value: JSON.stringify({ flowId: created.flowId, stepId: original[0]!.id }) }, context, request);
  const reordered = await readSteps();
  expect(reordered.map(step => step.id)).toEqual([original[1]!.id, original[0]!.id, original[2]!.id, original[3]!.id]);
  expect(Object.fromEntries(reordered.map(step => [step.id, step.dependsOn]))).toEqual(Object.fromEntries(restored.map(step => [step.id, step.dependsOn])));
  expect(JSON.stringify((await workbench.render(request, context)).children)).toContain("上下移动只调整显示位置");
});

test("creating a workflow keeps the oldest record after one hundred entries and a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-retention-"));
  roots.push(root);
  await writeFile(join(root, "flows.json"), JSON.stringify({ version: 1, flows: Array.from({ length: 100 }, (_, index) => ({
    id: `flow-${index}`, projectId: "project", title: `Flow ${index}`, state: "draft", createdAt: index,
    steps: [{ id: `step-${index}`, title: "First", instruction: "Do first", state: "pending" }],
  })) }));
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {}, runBackground() {}, scheduling: {
    options: async () => ({ models: [] }), target() {}, prepare() {}, startRole() {}, result() {}, inspect() {},
  } } as unknown as PluginContext;
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const first = await activate(host);
  await first?.tools?.[0]?.execute({ title: "New flow", steps: [{ title: "First", instruction: "Do first" }, { title: "Second", instruction: "Do second" }] }, context);
  expect((JSON.parse(await readFile(join(root, "flows.json"), "utf8")) as { flows: unknown[] }).flows).toHaveLength(101);
  const workbench = fixtureResultCard(await activate(host), root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const bound = { ...request, tool: { name: "workflow_draft", input: "{}", result: JSON.stringify({ flowId: "flow-99" }) } };
  expect((await workbench.render(bound, context)).data?.active).toMatchObject({ id: "flow-99", title: "Flow 99" });
  expect(JSON.stringify((await workbench.render(bound, context)).children)).toContain("Flow 99");
});

test("a model draft waits for user confirmation and then runs native step conversations in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-test-"));
  roots.push(root);
  const started: string[] = [];
  const selections: { profileId: string; model: string }[] = [];
  let reviewEnabled = true;
  let background: Promise<void> | undefined;
  const host = {
    storagePath: root,
    signal: new AbortController().signal,
    invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ conversations: [], models: [
        { profileId: "local", name: "Local", models: ["test-model"], efforts: { "test-model": ["medium"] } },
        ...(reviewEnabled ? [{ profileId: "review", name: "Review", models: ["review-model"], efforts: { "review-model": ["high"] } }] : []),
      ] }),
      target: async (projectId: string, sessionId: string, selection: { profileId: string; model: string }) => { selections.push(selection); return { projectId, sessionId, selection }; },
      prepare: async (target: object) => ({ ...target, sessionId: `session-${started.length + 1}` }),
      startRole: async (_target: unknown, role: { name: string }) => { started.push(role.name); return { runId: `run-${started.length}` }; },
      inspect: async () => ({ outcome: "completed" }),
      result: async (_target: unknown, runId: string) => ({ outcome: "completed", text: `result of ${runId}` }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  if (!contributions?.tools || !contributions.ui) throw new Error("Workflow contributions missing");
  const context = { projectId: "project", sessionId: "parent", runId: "parent-run", signal: host.signal } as ToolContext;
  const output = await contributions.tools[0]!.execute({ title: "Release", steps: [
    { title: "Implement", instruction: "Change code" },
    { title: "Verify", instruction: "Run checks" },
  ] }, context) as { flowId: string };
  expect(started).toEqual([]);
  const workbench = fixtureResultCard(contributions, root)!;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const draft = await workbench.render(request, context);
  const stepForms = draft.children.filter(node => node.type === "form" && node.action === "editStep");
  expect(stepForms).toHaveLength(1);
  expect(stepForms.every(node => node.type === "form" && node.multiline)).toBe(true);
  const stepButtons = draft.children.filter(node => node.type === "button" && node.action === "showStep");
  const first = JSON.parse(stepButtons[0]!.type === "button" ? stepButtons[0]!.value! : "{}") as { stepId: string };
  const second = JSON.parse(stepButtons[1]!.type === "button" ? stepButtons[1]!.value! : "{}") as { stepId: string };
  await workbench.act!({ id: "editTitle", value: JSON.stringify({ context: JSON.stringify({ flowId: output.flowId }), text: "Release safely" }) }, context, request);
  await workbench.act!({ id: "addStep", value: JSON.stringify({ context: JSON.stringify({ flowId: output.flowId, stepId: first.stepId }), text: "Review" }) }, context, request);
  let edited = await workbench.render(request, context);
  expect(JSON.stringify(edited.children)).toContain("Release safely");
  expect(JSON.stringify(edited.children)).toContain("Review");
  const reviewForm = edited.children.find(node => node.type === "form" && node.action === "editStepTitle" && node.initialValue === "Review");
  const review = JSON.parse(reviewForm?.type === "form" ? reviewForm.context! : "{}") as { stepId: string };
  await workbench.act!({ id: "moveDown", value: JSON.stringify({ flowId: output.flowId, stepId: review.stepId }) }, context, request);
  await workbench.act!({ id: "requestDeleteStep", value: JSON.stringify({ flowId: output.flowId, stepId: second.stepId }) }, context, request);
  await workbench.act!({ id: "deleteStep", value: JSON.stringify({ flowId: output.flowId, stepId: second.stepId }) }, context, request);
  edited = await workbench.render(request, context);
  expect(JSON.stringify(edited.children)).not.toContain("Run checks");
  const reviewSelect = edited.children.find(node => node.type === "select" && node.action === "setModel" && JSON.parse(node.context ?? "{}").stepId === review.stepId);
  if (reviewSelect?.type !== "select") throw new Error("Review model selector missing");
  const chosen = reviewSelect.options.find(option => option.label === "Review / review-model");
  expect(chosen).toBeDefined();
  await expect(workbench.act!({ id: "setModel", value: JSON.stringify({ context: reviewSelect.context, value: "unavailable" }) }, context, request)).rejects.toThrow("不可用");
  await workbench.act!({ id: "setModel", value: JSON.stringify({ context: reviewSelect.context, value: chosen!.value }) }, context, request);
  reviewEnabled = false;
  await expect(workbench.act!({ id: "start", value: output.flowId }, context, request)).rejects.toThrow("模型已不可用");
  expect(started).toEqual([]);
  reviewEnabled = true;
  await workbench.act!({ id: "start", value: output.flowId }, context, { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" });
  await background;
  expect(started).toEqual(["Implement", "Review"]);
  expect(selections).toMatchObject([{ profileId: "local", model: "test-model" }, { profileId: "review", model: "review-model" }]);
  const view = await workbench.render({ id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" }, context);
  expect(JSON.stringify(view.children)).toContain("已完成");
  expect(JSON.stringify(view.children)).toContain("session-2");
  const another = await contributions.tools[0]!.execute({ title: "Second flow", steps: [
    { title: "Draft", instruction: "Draft note" }, { title: "Review", instruction: "Review note" },
  ] }, context) as { flowId: string };
  const selectedView = await workbench.render(request, context);
  expect(JSON.stringify(selectedView.children)).toContain("Draft note");
  expect(JSON.stringify(selectedView.children)).not.toContain("Change code");
  const switched = await workbench.render({ ...request, tool: { name: "workflow_draft", input: "{}", result: JSON.stringify({ flowId: output.flowId }) } }, context);
  expect(JSON.stringify(switched.children)).toContain("Change code");
  expect(JSON.stringify(switched.children)).not.toContain("Draft note");
  expect(another.flowId).not.toBe(output.flowId);
});

test("retry keeps completed steps when their former model is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-retry-test-"));
  roots.push(root);
  let localEnabled = true;
  let background: Promise<void> | undefined;
  const models = () => [
    ...(localEnabled ? [{ profileId: "local", name: "Local", models: ["local-model"], efforts: { "local-model": ["medium"] } }] : []),
    { profileId: "review", name: "Review", models: ["review-model"], efforts: { "review-model": ["high"] } },
  ];
  const started: string[] = [];
  const host = {
    storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ conversations: [], models: models() }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object) => ({ ...target, sessionId: `session-${started.length + 1}` }),
      startRole: async (_target: unknown, role: { name: string }) => { started.push(role.name); return { runId: `run-${started.length}` }; },
      inspect: async (_target: unknown, runId: string) => {
        if (runId === "run-2") return { outcome: "failed" };
        return { outcome: "completed" };
      },
      result: async () => ({ outcome: "completed", text: "done" }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const workbench = fixtureResultCard(contributions, root);
  if (!workbench?.act || !workbench.render || !contributions.tools?.[0]) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", sessionId: "parent", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const { flowId } = await contributions.tools[0].execute({ title: "Check", steps: [
    { title: "Implement", instruction: "Implement feature" }, { title: "Review", instruction: "Review result" },
  ] }, context) as { flowId: string };
  const draft = await workbench.render(request, context);
  const stepButtons = draft.children.filter(node => node.type === "button" && node.action === "showStep");
  for (const [index, model] of ["local-model", "review-model"].entries()) {
    if (index) await workbench.act({ id: "showStep", value: stepButtons[index]?.type === "button" ? stepButtons[index].value : undefined }, context, request);
    const current = await workbench.render(request, context);
    const selector = current.children.find(node => node.type === "select" && node.action === "setModel");
    if (selector?.type !== "select") throw new Error("Missing model selector");
    const option = selector.options.find(item => item.label.includes(model));
    await workbench.act({ id: "setModel", value: JSON.stringify({ context: selector.context, value: option?.value }) }, context, request);
  }
  await workbench.act({ id: "start", value: flowId }, context, request);
  await background;
  expect(started).toEqual(["Implement", "Review"]);
  const failedView = await workbench.render(request, context);
  expect(JSON.stringify(failedView.children)).toContain("已完成步骤不会重跑");
  localEnabled = false;
  await workbench.act({ id: "retry", value: flowId }, context, request);
  await background;
  expect(started).toEqual(["Implement", "Review", "Review"]);
  const view = await workbench.render(request, context);
  expect(JSON.stringify(view.children)).toContain("已完成");
});

test("an uncertain step can be rerun only after explicit review and keeps its previous session", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-uncertain-test-"));
  roots.push(root);
  const selection = { profileId: "local", model: "test-model", reasoningEffort: "medium" };
  await writeFile(join(root, "flows.json"), JSON.stringify({ version: 1, flows: [{
    id: "flow", projectId: "project", title: "Recover", state: "running", createdAt: 1,
    steps: [
      { id: "first", title: "First", instruction: "Do first", state: "running", target: { projectId: "project", sessionId: "old-session", selection }, runId: "old-run" },
      { id: "second", title: "Second", instruction: "Do second", state: "pending" },
    ],
  }] }));
  let busy = true;
  let background: Promise<void> | undefined;
  const started: string[] = [];
  const host = {
    storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ conversations: [], models: [{ profileId: "local", name: "Local", models: ["test-model"], efforts: { "test-model": ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, chosen: unknown) => ({ projectId, sessionId, selection: chosen }),
      prepare: async (target: object) => ({ ...target, sessionId: `new-session-${started.length + 1}` }),
      startRole: async (_target: unknown, role: { name: string }) => { started.push(role.name); return { runId: `new-run-${started.length}` }; },
      inspect: async (_target: unknown, runId?: string) => runId === "old-run" ? { busy: false, outcome: "unknown" } : !runId ? { busy, outcome: busy ? "running" : "unknown" } : { busy: false, outcome: "completed" },
      result: async () => ({ outcome: "completed", text: "done" }),
    },
  } as unknown as PluginContext;
  const workbench = fixtureResultCard(await activate(host), root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", sessionId: "parent", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const uncertain = await workbench.render(request, context);
  expect(JSON.stringify(uncertain.children)).toContain("已核实，重新执行此步骤");
  await expect(workbench.act({ id: "retry", value: "flow" }, context, request)).rejects.toThrow("结果未能确认");
  await expect(workbench.act({ id: "rerunUnknown", value: "flow" }, context, request)).rejects.toThrow("状态已变化");
  busy = false;
  await workbench.act({ id: "rerunUnknown", value: "flow" }, context, request);
  await background;
  expect(started).toEqual(["First", "Second"]);
  const completed = await workbench.render(request, context);
  expect(JSON.stringify(completed.children)).toContain("old-session");
  expect(JSON.stringify(completed.children)).toContain("new-session-1");
  expect(JSON.stringify(completed.children)).toContain("已完成");
});

test("parallel approval buttons confirm only their own step", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-parallel-approval-"));
  roots.push(root);
  await writeFile(join(root, "flows.json"), JSON.stringify({ version: 1, flows: [{
    id: "flow", projectId: "project", title: "Release", state: "paused", createdAt: Date.now(), steps: [
      { id: "security", title: "Security review", instruction: "Check security", kind: "approval", state: "awaitingApproval", dependsOn: [] },
      { id: "product", title: "Product review", instruction: "Check product", kind: "approval", state: "awaitingApproval", dependsOn: [] },
      { id: "release", title: "Release", instruction: "Release after both reviews", kind: "task", state: "pending", dependsOn: ["security", "product"] },
    ],
  }] }));
  const started: string[] = [];
  let background: Promise<void> | undefined;
  const host = {
    storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ conversations: [], models: [{ profileId: "local", name: "Local", models: ["test-model"], efforts: { "test-model": ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object) => ({ ...target, sessionId: "release-session" }),
      startRole: async (_target: unknown, role: { name: string }) => { started.push(role.name); return { runId: "release-run" }; },
      inspect: async () => ({ outcome: "completed" }),
      result: async () => ({ outcome: "completed", text: "released" }),
    },
  } as unknown as PluginContext;
  const workbench = fixtureResultCard(await activate(host), root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const paused = await workbench.render(request, context);
  const approvals = paused.children.filter(node => node.type === "button" && node.action === "approveStep");
  expect(approvals).toHaveLength(2);
  const product = approvals.find(node => node.type === "button" && node.label.includes("Product review"));
  if (product?.type !== "button") throw new Error("Product approval missing");
  await expect(workbench.act({ id: "approveStep", value: "flow" }, context, request)).rejects.toThrow("指定");
  await expect(workbench.act({ id: "approveStep", value: JSON.stringify({ flowId: "flow", stepId: "release" }) }, context, request)).rejects.toThrow("未等待确认");
  await workbench.act({ id: "approveStep", value: product.value }, context, request);
  await background;
  expect(started).toEqual([]);
  const afterProduct = (await workbench.render(request, context)).data?.active as { state: string; steps: { id: string; state: string }[] };
  expect(afterProduct.state).toBe("paused");
  expect(afterProduct.steps.find(step => step.id === "product")?.state).toBe("completed");
  expect(afterProduct.steps.find(step => step.id === "security")?.state).toBe("awaitingApproval");
  const remaining = (await workbench.render(request, context)).children.find(node => node.type === "button" && node.action === "approveStep");
  await workbench.act({ id: "approveStep", value: remaining?.type === "button" ? remaining.value : undefined }, context, request);
  await background;
  expect(started).toEqual(["Release"]);
  expect((await workbench.render(request, context)).data?.active).toMatchObject({ state: "completed" });
});

test("an approval can be confirmed while an independent task is still running", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-approval-parallel-task-"));
  roots.push(root);
  const started: string[] = [];
  let background: Promise<void> | undefined;
  let backgroundStarts = 0;
  let checkFinished = false;
  const host = { storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { backgroundStarts++; background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ models: [{ profileId: "local", name: "Local", models: ["test"], efforts: { test: ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object) => ({ ...target, sessionId: `session-${started.length + 1}` }),
      startRole: async (_target: unknown, role: { name: string }) => { started.push(role.name); return { runId: `run-${started.length}` }; },
      inspect: async (_target: unknown, runId: string) => ({ outcome: runId === "run-1" && !checkFinished ? "running" : "completed" }), result: async () => ({ outcome: "completed", text: "done" }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const context = { projectId: "project", signal: host.signal } as ToolContext;
  const created = await contributions?.tools?.[0]?.execute({ title: "Release", steps: [
    { title: "Human review", instruction: "Review", after: [] },
    { title: "Independent check", instruction: "Check", after: [] },
    { title: "Publish", instruction: "Publish", after: [1, 2] },
  ] }, context) as { flowId: string };
  const flow = (JSON.parse(await readFile(join(root, "flows.json"), "utf8")) as { flows: { steps: { id: string }[] }[] }).flows[0]!;
  const workbench = fixtureResultCard(contributions, root);
  if (!workbench?.act || !workbench.render) throw new Error("Workflow workbench missing");
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  await workbench.act({ id: "setStepKind", value: JSON.stringify({ context: JSON.stringify({ flowId: created.flowId, stepId: flow.steps[0]!.id }), value: "approval" }) }, context, request);
  await workbench.act({ id: "start", value: created.flowId }, context, request);
  for (let attempt = 0; attempt < 50 && !started.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(started).toEqual(["Independent check"]);
  const running = await workbench.render(request, context);
  expect(running.data?.active).toMatchObject({ state: "running" });
  expect(running.children.some(node => node.type === "button" && node.action === "approveStep")).toBe(true);
  await workbench.act({ id: "approveStep", value: JSON.stringify({ flowId: created.flowId, stepId: flow.steps[0]!.id }) }, context, request);
  expect(backgroundStarts).toBe(1);
  expect(started).toEqual(["Independent check"]);
  checkFinished = true;
  await background;
  expect(started).toEqual(["Independent check", "Publish"]);
  expect(backgroundStarts).toBe(1);
  expect((await workbench.render(request, context)).data?.active).toMatchObject({ state: "completed" });
});

test("an approval step pauses after prior work and resumes from persisted state", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-approval-test-"));
  roots.push(root);
  const started: string[] = [];
  let background: Promise<void> | undefined;
  const host = {
    storagePath: root, signal: new AbortController().signal, invalidateUi() {},
    runBackground(_context: unknown, task: (signal: AbortSignal) => Promise<void>) { background = task(new AbortController().signal); },
    scheduling: {
      options: async () => ({ conversations: [], models: [{ profileId: "local", name: "Local", models: ["test-model"], efforts: { "test-model": ["medium"] } }] }),
      target: async (projectId: string, sessionId: string, selection: unknown) => ({ projectId, sessionId, selection }),
      prepare: async (target: object) => ({ ...target, sessionId: `session-${started.length + 1}` }),
      startRole: async (_target: unknown, role: { name: string }) => { started.push(role.name); return { runId: `run-${started.length}` }; },
      inspect: async () => ({ outcome: "completed" }),
      result: async () => ({ outcome: "completed", text: "verified result" }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const workbench = fixtureResultCard(contributions, root);
  if (!workbench?.act || !workbench.render || !contributions.tools?.[0]) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", sessionId: "parent", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const { flowId } = await contributions.tools[0].execute({ title: "Ship", steps: [
    { title: "Implement", instruction: "Implement change" },
    { title: "Check", instruction: "Check the implementation before continuing" },
    { title: "Deploy", instruction: "Deploy change" },
  ] }, context) as { flowId: string };
  const draft = await workbench.render(request, context);
  const secondStep = draft.children.filter(node => node.type === "button" && node.action === "showStep")[1];
  await workbench.act({ id: "showStep", value: secondStep?.type === "button" ? secondStep.value : undefined }, context, request);
  const approvalSelector = (await workbench.render(request, context)).children.find(node => node.type === "select" && node.action === "setStepKind");
  if (approvalSelector?.type !== "select") throw new Error("Approval selector missing");
  await workbench.act({ id: "setStepKind", value: JSON.stringify({ context: approvalSelector.context, value: "approval" }) }, context, request);
  const edited = await workbench.render(request, context);
  expect(JSON.stringify(edited.children)).toContain("保存确认条件");
  await workbench.act({ id: "start", value: flowId }, context, request);
  await background;
  expect(started).toEqual(["Implement"]);
  const paused = await workbench.render(request, context);
  expect(JSON.stringify(paused.children)).toContain("等待人工确认");
  const approval = paused.children.find(node => node.type === "button" && node.action === "approveStep");
  expect(approval?.type === "button" ? JSON.parse(approval.value ?? "{}") : undefined).toMatchObject({ flowId });
  const restarted = fixtureResultCard(await activate(host), root);
  if (!restarted?.act || !restarted.render) throw new Error("Restarted workbench missing");
  await restarted.act({ id: "approveStep", value: approval?.type === "button" ? approval.value : undefined }, context, request);
  await background;
  expect(started).toEqual(["Implement", "Deploy"]);
  await expect(restarted.act({ id: "approveStep", value: flowId }, context, request)).rejects.toThrow("未等待确认");
  const completed = await restarted.render(request, context);
  expect(JSON.stringify(completed.children)).toContain("用户已确认");
  expect(JSON.stringify(completed.children)).toContain("已完成");
});
