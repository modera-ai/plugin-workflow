const api = window.moderaPlugin;
const app = document.getElementById("app");
let snapshot, error = "", busy = false, selectedStepId, selectedFlowId;
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const attr = value => escape(JSON.stringify(value));
const labels = { draft: "待确认", running: "运行中", paused: "等待人工确认", completed: "已完成", failed: "失败", interrupted: "需核实", pending: "等待执行", awaitingApproval: "等待你的确认" };
const button = (label, action, value, extra = "") => `<button class="button ${extra}" type="button" data-action="${escape(action)}" data-value="${escape(value ?? "")}">${escape(label)}</button>`;
const form = (label, action, flowId, stepId, value, multiline = false) => `<form class="field" data-edit="${escape(action)}" data-flow="${escape(flowId)}" data-step="${escape(stepId ?? "")}"><label>${escape(label)}</label>${multiline ? `<textarea maxlength="3800">${escape(value)}</textarea>` : `<input maxlength="120" value="${escape(value)}">`}<button class="button small" type="submit">保存</button></form>`;

function graph(flow) {
  const steps = flow.steps;
  const map = new Map(steps.map(step => [step.id, step]));
  const depths = new Map();
  const depth = step => {
    if (depths.has(step.id)) return depths.get(step.id);
    const value = Math.max(-1, ...step.dependsOn.map(id => depth(map.get(id)))) + 1;
    depths.set(step.id, value);
    return value;
  };
  for (const step of steps) depth(step);
  const groups = new Map();
  for (const step of steps) { const layer = depths.get(step.id); groups.set(layer, [...(groups.get(layer) ?? []), step]); }
  const positions = new Map();
  for (const [layer, group] of groups) group.forEach((step, index) => positions.set(step.id, { x: layer * 244 + 12, y: index * 132 + 14 }));
  const width = Math.max(440, (Math.max(...depths.values()) + 1) * 244 + 32);
  const height = Math.max(300, Math.max(...[...groups.values()].map(group => group.length)) * 132 + 30);
  const edges = steps.flatMap(step => step.dependsOn.map(id => {
    const source = positions.get(id), target = positions.get(step.id);
    if (!source || !target) return "";
    const x1 = source.x + 190, y1 = source.y + 47, x2 = target.x, y2 = target.y + 47;
    return `<path d="M${x1},${y1} C${x1 + 30},${y1} ${x2 - 30},${y2} ${x2},${y2}" fill="none" stroke="var(--accent)" stroke-width="2" opacity=".62" marker-end="url(#arrow)"/>`;
  })).join("");
  const cards = steps.map((step, index) => {
    const point = positions.get(step.id);
    return `<button class="step-card ${escape(step.state)} ${step.id === selectedStepId ? "selected" : ""}" type="button" data-select-step="${escape(step.id)}" style="left:${point.x}px;top:${point.y}px"><span class="number">${String(index + 1).padStart(2, "0")} · ${step.kind === "approval" ? "人工确认" : "执行任务"}</span><strong>${escape(step.title)}</strong><small>${escape(flow.state === "interrupted" && step.state === "running" ? "待核实" : labels[step.state] ?? step.state)}</small></button>`;
  }).join("");
  return `<div class="graph-wrap"><div class="graph-heading">步骤关系 · 点击节点查看与编辑</div><div class="graph-scroll"><div class="graph" style="width:${width}px;height:${height}px"><svg class="edges" width="${width}" height="${height}" aria-hidden="true"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="var(--accent)"/></marker></defs>${edges}</svg>${cards}</div></div></div>`;
}

function inspector(flow, data) {
  const step = flow.steps.find(item => item.id === selectedStepId) ?? flow.steps[0];
  if (!step) return "";
  const draft = flow.state === "draft";
  const options = data.models ?? [];
  const selectedModel = step.selection ? JSON.stringify([step.selection.profileId, step.selection.model]) : "default";
  const modelPicker = `<div class="field"><label>本步执行模型</label><select data-model="${escape(step.id)}"><option value="default">默认模型</option>${options.map(item => `<option value="${escape(item.value)}" ${item.value === selectedModel ? "selected" : ""}>${escape(item.label)}</option>`).join("")}${selectedModel !== "default" && !options.some(item => item.value === selectedModel) ? `<option value="${escape(selectedModel)}" selected>当前选择已不可用</option>` : ""}</select></div>`;
  const prerequisites = flow.steps.filter(item => item.id !== step.id).map(item => `<button type="button" class="dependency ${step.dependsOn.includes(item.id) ? "selected" : ""}" data-action="toggleDependency" data-value="${attr({ flowId: flow.id, stepId: step.id, prerequisiteId: item.id })}"><span>${step.dependsOn.includes(item.id) ? "✓" : "+"} ${escape(item.title)}</span><small>${step.dependsOn.includes(item.id) ? "前置" : "添加"}</small></button>`).join("");
  const prior = step.dependsOn.map(id => flow.steps.find(item => item.id === id)?.title).filter(Boolean).join("、") || "无，可立即开始";
  const deleteValue = JSON.stringify({ flowId: flow.id, stepId: step.id });
  const deleting = data.deleteStepId === step.id;
  const affected = flow.steps.filter(item => item.dependsOn.includes(step.id)).length;
  const deleteActions = flow.steps.length <= 2 ? "" : deleting
    ? `<p role="alert">确认删除「${escape(step.title)}」？${affected} 个直接后续步骤将改为依赖它的前置步骤。</p>${button("确认删除步骤", "deleteStep", deleteValue, "danger")}${button("取消删除", "cancelDeleteStep", deleteValue)}`
    : button("删除步骤", "requestDeleteStep", deleteValue, "danger");
  return `<aside class="inspector"><h3>${escape(step.title)}</h3><p>${escape(flow.state === "interrupted" && step.state === "running" ? "待核实" : labels[step.state] ?? step.state)} · ${step.kind === "approval" ? "人工确认" : "执行任务"}</p>${draft ? `
    ${form("步骤名称", "editStepTitle", flow.id, step.id, step.title)}
    <div class="field"><label>步骤类型</label><select data-kind="${escape(step.id)}"><option value="task" ${step.kind === "task" ? "selected" : ""}>执行任务</option><option value="approval" ${step.kind === "approval" ? "selected" : ""}>人工确认</option></select></div>
    ${form(step.kind === "approval" ? "确认条件" : "目标与完成条件", "editStep", flow.id, step.id, step.instruction, true)}
    ${step.kind === "task" ? modelPicker : ""}
    <div class="section"><h4>完成这些步骤后开始</h4><p>没有前置步骤的任务可同时运行；汇总步骤可选择多个前置步骤。</p>${prerequisites}</div>
    <div class="section"><h4>整理步骤</h4>${flow.steps.length < 10 ? `<form class="field" data-edit="addStep" data-flow="${escape(flow.id)}" data-step="${escape(step.id)}"><label>插入后续步骤（原后续步骤将等待它完成）</label><input maxlength="120" placeholder="新步骤名称"><button class="button small" type="submit">插入步骤</button></form>` : ""}<p>上下移动只调整显示位置；执行先后由前置步骤决定。</p><div class="actions">${flow.steps.indexOf(step) > 0 ? button("上移显示位置", "moveUp", JSON.stringify({ flowId: flow.id, stepId: step.id })) : ""}${flow.steps.indexOf(step) < flow.steps.length - 1 ? button("下移显示位置", "moveDown", JSON.stringify({ flowId: flow.id, stepId: step.id })) : ""}${deleteActions}</div></div>` : `
    <div class="section"><h4>任务要求</h4><div class="result">${escape(step.instruction)}</div></div>
    <div class="section"><h4>前置步骤</h4><p>${escape(prior)}</p></div>
    ${step.kind === "task" && step.state === "pending" && ["paused", "failed", "interrupted"].includes(flow.state) ? modelPicker : ""}
    ${step.result ? `<div class="section"><h4>执行结果预览</h4><div class="result">${escape(step.result)}</div>${step.resultTruncated || step.resultPreviewTruncated ? `<p>此处只显示部分结果，请打开步骤会话查看完整内容。</p>` : ""}</div>` : ""}
    ${step.target?.sessionId ? `<div class="actions">${button("打开步骤会话", "openConversation", step.target.sessionId)}</div>` : ""}
    ${flow.state === "failed" && step.state === "failed" && step.target?.sessionId && step.runId ? `<form class="field" data-edit="continueFailed" data-flow="${escape(flow.id)}" data-step="${escape(step.id)}"><label>在原会话继续此步骤</label><textarea maxlength="3800" placeholder="补充失败原因或下一步要求（可留空）"></textarea><button class="button small" type="submit">继续原会话</button></form>` : ""}
    ${(step.previousSessions ?? []).filter(id => id !== step.target?.sessionId).map(id => button("打开上次会话", "openConversation", id)).join("")}
    ${["paused", "running"].includes(flow.state) && step.state === "awaitingApproval" ? `<div class="actions">${button(`已检查「${step.title}」，继续`, "approveStep", JSON.stringify({ flowId: flow.id, stepId: step.id }), "primary")}</div>` : ""}`}
  </aside>`;
}

function render() {
  const data = snapshot?.view?.data ?? {};
  const flow = data.active;
  if (flow?.id !== selectedFlowId) { selectedFlowId = flow?.id; selectedStepId = data.selectedStepId ?? flow?.steps[0]?.id; }
  if (flow && !flow.steps.some(item => item.id === selectedStepId)) selectedStepId = flow.steps[0]?.id;
  const theme = snapshot?.theme;
  document.documentElement.style.colorScheme = theme?.mode ?? "light";
  if (theme?.colors) for (const [key, value] of Object.entries({ bg: theme.colors.page, paper: theme.colors.card, ink: theme.colors.ink, muted: theme.colors.muted, line: theme.colors.line, accent: theme.accent, soft: theme.colors.soft })) if (value) document.documentElement.style.setProperty(`--${key}`, value);
  const flows = data.flows ?? [];
  app.innerHTML = `<div class="layout"><aside class="sidebar"><h1>工作流</h1><p>先检查步骤关系，再启动执行</p><div class="flow-list">${flows.map(item => `<button class="flow-item ${item.id === flow?.id ? "selected" : ""}" type="button" data-action="showFlow" data-value="${escape(item.id)}"><strong>${escape(item.title)}</strong><small>${escape(labels[item.state] ?? item.state)} · ${item.stepCount} 步</small></button>`).join("")}</div>${data.totalFlows > 10 ? `<div class="pager"><span>${data.totalFlows} 项 · 第 ${data.page + 1}/${data.pageCount} 页</span>${data.page > 0 ? button("上一页", "showPage", String(data.page - 1), "small") : ""}${data.page + 1 < data.pageCount ? button("下一页", "showPage", String(data.page + 1), "small") : ""}</div>` : ""}${!flows.length ? `<p class="muted">尚无工作流。在聊天中输入 /workflow 和目标即可生成草稿。</p>` : ""}<div class="section"><form data-create><label class="muted">快速创建草稿</label><div class="field"><label for="quick-flow-title">工作流名称</label><input id="quick-flow-title" name="title" placeholder="例如：发布新版本" maxlength="120" required></div><div class="field"><label for="quick-flow-steps">步骤（用分号分隔 2–10 步）</label><textarea id="quick-flow-steps" name="steps" placeholder="设计；实现；检查" maxlength="4000" required></textarea></div><button class="button small" type="submit">创建草稿</button></form></div></aside><main class="main"><div class="top"><div><h2>${escape(flow?.title ?? "选择工作流")}</h2><p>${flow ? `${flow.steps.length} 个步骤 · 根据前置关系执行` : "在聊天输入 /workflow 与目标，或用左侧快速草稿开始"}</p></div>${flow ? `<div class="toolbar"><span class="status ${escape(flow.state)}">${escape(labels[flow.state] ?? flow.state)}</span>${button("刷新", "refresh")}</div>` : ""}</div>${error ? `<div class="error" role="alert">${escape(error)}</div>` : ""}${flow ? `${flow.state === "draft" ? `<div class="guide">点击节点编辑；点击右侧的前置步骤可添加或移除依赖。无前置步骤的任务会并行执行，但所有任务共用当前项目目录；可能改同一文件时请添加前置依赖。</div>${form("工作流名称", "editTitle", flow.id, "", flow.title)}` : ""}${graph(flow)}${flow.error ? `<div class="error">${escape(flow.error)}</div>` : ""}<div class="flow-footer actions">${flow.state === "draft" ? button("确认并开始", "start", flow.id, "primary") : ""}${["failed", "interrupted"].includes(flow.state) ? (["unknown", "interrupted"].includes(data.outcome) ? `<span class="muted">先打开状态不明的步骤会话核实；重跑可能重复外部操作。</span>${button("已核实，重跑状态不明步骤", "rerunUnknown", flow.id)}` : button("在新会话重试未完成步骤", "retry", flow.id)) : ""}</div>` : `<div class="empty">把复杂任务拆成可检查的步骤。独立步骤可以并行，汇总步骤会等待前置结果。</div>`}</main>${flow ? inspector(flow, data) : `<aside class="inspector"><h3>使用提示</h3><p>描述目标后先查看草稿，确认依赖和每步模型，再开始运行。</p></aside>`}</div>`;
}

async function act(action, value) {
  if (busy) return;
  if (action === "openConversation") { try { await api.openConversation(value); } catch (cause) { error = String(cause); render(); } return; }
  busy = true; error = "";
  try { snapshot = await api.action(action, value); render(); }
  catch (cause) { error = String(cause); render(); }
  finally { busy = false; }
}

app.addEventListener("click", event => {
  const select = event.target.closest("[data-select-step]");
  if (select) { selectedStepId = select.dataset.selectStep; render(); return; }
  const control = event.target.closest("[data-action]");
  if (control) void act(control.dataset.action, control.dataset.value || undefined);
});
app.addEventListener("change", event => {
  const control = event.target;
  if (control.matches("[data-kind]")) void act("setStepKind", JSON.stringify({ context: JSON.stringify({ flowId: selectedFlowId, stepId: control.dataset.kind }), value: control.value }));
  if (control.matches("[data-model]")) void act("setModel", JSON.stringify({ context: JSON.stringify({ flowId: selectedFlowId, stepId: control.dataset.model }), value: control.value }));
});
app.addEventListener("submit", event => {
  event.preventDefault();
  const formElement = event.target;
  if (formElement.matches("[data-create]")) { void act("create", JSON.stringify({ title: formElement.elements.title.value.trim(), steps: formElement.elements.steps.value.trim() })); return; }
  const text = formElement.querySelector("input,textarea")?.value;
  void act(formElement.dataset.edit, JSON.stringify({ context: JSON.stringify({ flowId: formElement.dataset.flow, stepId: formElement.dataset.step || undefined }), text }));
});
api.onChanged(async () => { try { snapshot = await api.snapshot(); render(); } catch (cause) { error = String(cause); render(); } });
api.snapshot().then(value => { snapshot = value; render(); return api.ready(); }).catch(cause => { error = String(cause); render(); });
