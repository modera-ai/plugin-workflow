import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import type { PluginContext, ToolContext } from "@modera/plugin-sdk";
import { activate } from "../src/index";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

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
  const workbench = contributions.ui.find(item => item.id === "modera.workflow.workbench")!;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const draft = await workbench.render(request, context);
  const stepForms = draft.children.filter(node => node.type === "form" && node.action === "editStep");
  expect(stepForms.every(node => node.type === "form" && node.multiline)).toBe(true);
  const first = JSON.parse(stepForms[0]!.type === "form" ? stepForms[0]!.context! : "{}") as { stepId: string };
  const second = JSON.parse(stepForms[1]!.type === "form" ? stepForms[1]!.context! : "{}") as { stepId: string };
  await workbench.act!({ id: "editTitle", value: JSON.stringify({ context: JSON.stringify({ flowId: output.flowId }), text: "Release safely" }) }, context, request);
  await workbench.act!({ id: "addStep", value: JSON.stringify({ context: JSON.stringify({ flowId: output.flowId, stepId: first.stepId }), text: "Review" }) }, context, request);
  let edited = await workbench.render(request, context);
  expect(JSON.stringify(edited.children)).toContain("Release safely");
  expect(JSON.stringify(edited.children)).toContain("Review");
  const reviewForm = edited.children.find(node => node.type === "form" && node.action === "editStepTitle" && node.initialValue === "Review");
  const review = JSON.parse(reviewForm?.type === "form" ? reviewForm.context! : "{}") as { stepId: string };
  await workbench.act!({ id: "moveDown", value: JSON.stringify({ flowId: output.flowId, stepId: review.stepId }) }, context, request);
  await workbench.act!({ id: "deleteStep", value: JSON.stringify({ flowId: output.flowId, stepId: second.stepId }) }, context, request);
  edited = await workbench.render(request, context);
  expect(JSON.stringify(edited.children)).not.toContain("Run checks");
  const reviewSelect = edited.children.find(node => node.type === "select" && JSON.parse(node.context ?? "{}").stepId === review.stepId);
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
  await workbench.act!({ id: "showFlow", value: output.flowId }, context, request);
  const switched = await workbench.render(request, context);
  expect(JSON.stringify(switched.children)).toContain("Change code");
  expect(JSON.stringify(switched.children)).not.toContain("Draft note");
  expect(another.flowId).not.toBe(output.flowId);
});

test("retry keeps completed steps when their former model is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "modera-workflow-retry-test-"));
  roots.push(root);
  let localEnabled = true;
  let failedOnce = false;
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
        if (runId === "run-2" && !failedOnce) { failedOnce = true; return { outcome: "failed" }; }
        return { outcome: "completed" };
      },
      result: async () => ({ outcome: "completed", text: "done" }),
    },
  } as unknown as PluginContext;
  const contributions = await activate(host);
  const workbench = contributions?.ui?.find(item => item.id === "modera.workflow.workbench");
  if (!workbench?.act || !workbench.render || !contributions.tools?.[0]) throw new Error("Workflow workbench missing");
  const context = { projectId: "project", sessionId: "parent", signal: host.signal } as ToolContext;
  const request = { id: workbench.id, sessionId: "", projectId: "project", locale: "zh-CN" };
  const { flowId } = await contributions.tools[0].execute({ title: "Check", steps: [
    { title: "Implement", instruction: "Implement feature" }, { title: "Review", instruction: "Review result" },
  ] }, context) as { flowId: string };
  const draft = await workbench.render(request, context);
  const selectors = draft.children.filter(node => node.type === "select");
  for (const [index, model] of ["local-model", "review-model"].entries()) {
    const selector = selectors[index];
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
  const workbench = (await activate(host))?.ui?.find(item => item.id === "modera.workflow.workbench");
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
