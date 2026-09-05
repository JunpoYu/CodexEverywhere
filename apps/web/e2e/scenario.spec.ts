import { expect, test } from "@playwright/test";

const TIMELINE_ANCHOR_TOLERANCE_PX = 6;

test("ScenarioGateway 完成任务创建、流式收口和主导航", async ({ page }) => {
  await page.goto("/?scenario=1");
  await page.getByRole("button", { name: "打开 ScenarioGateway" }).click();

  await expect(
    page.getByRole("heading", { name: "任务", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /欢迎使用 CodexEverywhere/u }).first(),
  ).toBeVisible();

  const prompt = "验证 v0.4 的 ScenarioGateway";
  await page.getByPlaceholder("描述你希望 Codex 完成的工作…").fill(prompt);
  await page.getByRole("button", { name: "新建任务" }).click();

  await expect(page.getByRole("heading", { name: prompt })).toBeVisible();
  await expect(
    page.locator(".timeline").getByText(prompt, { exact: true }),
  ).toBeVisible();
  await expectScenarioReply(page);

  const composer = page.getByLabel("给 Codex 的消息");
  await composer.fill("输入法候选确认");
  await composer.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
  });
  await expect(composer).toHaveValue("输入法候选确认");
  await expect(
    page.locator(".timeline").getByText("输入法候选确认", { exact: true }),
  ).toHaveCount(0);
  await composer.fill("第一行");
  await composer.press("Shift+Enter");
  await composer.type("第二行");
  await expect(composer).toHaveValue("第一行\n第二行");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(
    page.locator(".timeline").getByText("第一行\n第二行", { exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: /Queue/u }).last().click();
  await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
  await expect(page.getByText("Queue 为空")).toBeVisible();

  await page
    .getByRole("link", { name: /工作区/u })
    .last()
    .click();
  await expect(page.getByRole("heading", { name: "工作区" })).toBeVisible();
  await expect(page.getByText("/public/demo", { exact: true })).toBeVisible();
});

test("Scenario 管理端使用独立路由和 actor", async ({ page }) => {
  await page.goto("/admin?scenario=1");
  await page.getByRole("button", { name: "打开 ScenarioGateway" }).click();

  await expect(
    page.getByRole("heading", { name: "scenario-host", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("scenario-host", { exact: false })).toBeVisible();
});

test("审批期间可排入、Steer 和移除 Queue", async ({ page }) => {
  await openScenario(page);
  const prompt = "[approval] 验证审批和 Queue";
  await createTask(page, prompt);

  await expect(page.getByText("允许 Codex 执行命令？")).toBeVisible();
  const composer = page.getByLabel("给 Codex 的消息");
  await composer.fill("审批完成后继续检查 Queue");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(page.locator("main.conversation-page")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  await navigateTo(page, "/queue");
  const row = page.locator(".queue-row").filter({
    hasText: "审批完成后继续检查 Queue",
  });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "调整内容" }).click();
  await row.getByLabel("Steer 替换内容").fill("替换后的 Queue 请求");
  await row.getByRole("button", { name: "发送到当前任务" }).click();
  const updatedRow = page.locator(".queue-row").filter({
    hasText: "替换后的 Queue 请求",
  });
  await expect(updatedRow).toBeVisible();
  await updatedRow.getByRole("button", { name: "移除" }).click();
  await expect(page.getByText("Queue 为空")).toBeVisible();

  await navigateTo(page, "/tasks");
  await openTaskCard(page, prompt);
  await page.getByRole("button", { name: "允许", exact: true }).click();
  await expectScenarioReply(page);
});

test("用户问答与 MCP elicitation 固定显示在 composer 上方", async ({
  page,
}) => {
  await openScenario(page);

  await createTask(page, "[question] 验证用户问答");
  await expect(page.getByText("Codex 需要你的输入")).toBeVisible();
  await page.getByLabel("目标环境").selectOption("Staging");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expectScenarioReply(page);

  await navigateTo(page, "/tasks");
  await createTask(page, "[mcp] 验证 MCP elicitation");
  await expect(page.getByText("外部工具请求确认")).toBeVisible();
  await page.getByLabel("返回给 MCP 的结构化内容").fill('{"approved":true}');
  await page.getByRole("button", { name: "允许", exact: true }).click();
  await expectScenarioReply(page);
});

test("额度类 turn 失败结束后可以直接发送新消息重试", async ({ page }) => {
  await openScenario(page);
  await createTask(page, "[usage-limit] 验证失败后恢复");

  await expect(
    page.getByText(
      "上一次运行已经失败并结束；限制或连接恢复后，可直接发送新消息继续此任务。",
      { exact: true },
    ),
  ).toBeVisible();
  const composer = page.getByLabel("给 Codex 的消息");
  const send = page.getByRole("button", { name: "发送", exact: true });
  await composer.fill("额度已经恢复，继续执行");
  await expect(send).toBeEnabled();
  await composer.press("Enter");

  await expect(composer).toHaveValue("");
  await expect(
    page.locator(".timeline").getByText("额度已经恢复，继续执行", {
      exact: true,
    }),
  ).toBeVisible();
  await expectScenarioReply(page);
});

test("任务可重命名、归档、取消归档并删除", async ({ page }) => {
  await openScenario(page);
  await createTask(page, "任务生命周期原始名称");
  await expectScenarioReply(page);

  await openTaskActions(page);
  await page.getByRole("button", { name: "重命名" }).click();
  await page.getByLabel("任务名称").fill("任务生命周期新名称");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(
    page.getByRole("heading", { name: "任务生命周期新名称" }),
  ).toBeVisible();

  await openTaskActions(page);
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "任务", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看已归档" }).click();
  await openTaskCard(page, "任务生命周期新名称");
  await openTaskActions(page);
  await page.getByRole("button", { name: "取消归档" }).click();

  await expect(page.getByRole("button", { name: "查看已归档" })).toBeVisible();
  await openTaskCard(page, "任务生命周期新名称");
  await openTaskActions(page);
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "永久删除这个任务？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "永久删除" }).click();
  await expect(
    page.locator("[data-task-grid] [data-task-card]").filter({
      hasText: "任务生命周期新名称",
    }),
  ).toHaveCount(0);
});

test("任务权限可连续保存，并始终显示权威结果", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name.includes("mobile");
  if (!mobile) await page.setViewportSize({ width: 1600, height: 900 });
  await openScenario(page);
  await openTaskCard(page, "欢迎使用 CodexEverywhere");

  await expect(page.getByLabel("任务运行设置摘要")).toBeVisible();
  await expect(page.locator("aside.task-context")).toHaveCount(0);
  await expect(page.getByLabel("模型：Codex 当前值")).toBeVisible();
  await expect(page.getByLabel("推理：Codex 当前值")).toBeVisible();
  await expect(page.getByLabel("文件：Codex 当前值")).toBeVisible();
  await expect(page.getByLabel("审批：Codex 当前值")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("[data-task-context-values]")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  const runtimeSummary = await page
    .getByLabel("任务运行设置摘要")
    .boundingBox();
  const composerInput = await page.getByLabel("给 Codex 的消息").boundingBox();
  expect(runtimeSummary).not.toBeNull();
  expect(composerInput).not.toBeNull();
  if (runtimeSummary !== null && composerInput !== null) {
    if (mobile) {
      expect(runtimeSummary.y + runtimeSummary.height).toBeLessThanOrEqual(
        composerInput.y,
      );
    } else {
      expect(runtimeSummary.x + runtimeSummary.width).toBeLessThanOrEqual(
        composerInput.x,
      );
    }
  }
  await expect(
    page.getByRole("link", { name: "查看 Queue，当前 0 项" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "任务设置" }).click();
  const dialog = page.getByRole("dialog", { name: "任务权限与运行设置" });
  const save = dialog.getByRole("button", { name: "保存更改" });
  await expect(dialog).toBeVisible();
  await expect(save).toBeDisabled();

  await dialog.getByRole("radio", { name: /工作区可写/u }).click();
  await dialog.getByRole("radio", { name: /按需询问/u }).click();
  await expect(dialog.getByText("有未保存的更改")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(save).toBeEnabled();
  await save.click();

  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("设置已保存，并已应用到当前任务。"),
  ).toBeVisible();
  await expect(save).toBeDisabled();

  await dialog.getByRole("radio", { name: /只读/u }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog.getByRole("radio", { name: /只读/u })).toBeChecked();
  await expect(save).toBeDisabled();
  await expect(page.getByLabel("文件：只读")).toBeVisible();
  await expect(page.getByLabel("审批：按需询问")).toBeVisible();

  await dialog.getByRole("radio", { name: /完全访问/u }).click();
  await dialog.getByRole("radio", { name: /从不询问/u }).click();
  await save.click();
  await expect(
    dialog.getByText("设置已保存，并已应用到当前任务。"),
  ).toBeVisible();
  await expect(page.getByLabel("文件：完全访问")).toBeVisible();
  await expect(page.getByLabel("审批：从不询问")).toBeVisible();
  await expect(page.getByText("高权限", { exact: true })).toBeVisible();
  await expect(page.locator("[data-task-runtime-summary]")).toHaveAttribute(
    "data-elevated-access",
    "true",
  );
});

test("输入框下方显示工作目录，长路径只在自身区域滚动", async ({
  page,
}, testInfo) => {
  if (!testInfo.project.name.includes("mobile")) {
    await page.setViewportSize({ width: 1600, height: 900 });
  }
  await openScenario(page, "&scenarioLongWorkspace=1");
  await openTaskCard(page, "欢迎使用 CodexEverywhere");

  const directory = page.locator("[data-working-directory]");
  const pathRegion = directory.locator("[data-working-directory-path]");
  await expect(directory).toHaveAttribute("data-state", "ready");
  const path = await pathRegion.textContent();
  expect(path).not.toBeNull();
  expect(path).toMatch(/^\/public\/demo\//u);
  await expect(directory).toHaveAttribute("aria-label", `工作目录：${path}`);
  await expect(pathRegion).toHaveAttribute("title", path!);

  const [composerBox, directoryBox] = await Promise.all([
    page.getByLabel("给 Codex 的消息").boundingBox(),
    directory.boundingBox(),
  ]);
  expect(composerBox).not.toBeNull();
  expect(directoryBox).not.toBeNull();
  expect(directoryBox!.y).toBeGreaterThanOrEqual(
    composerBox!.y + composerBox!.height,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      pathRegion.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    )
    .toBe(true);
  await pathRegion.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(() => pathRegion.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await expect(pathRegion).toHaveCSS("overflow-x", "auto");
});

test("新任务展示全局默认权限，并允许仅覆盖本次任务", async ({ page }) => {
  await openScenario(page);

  const sandbox = page.getByLabel("本次任务 Sandbox");
  const approval = page.getByLabel("本次任务审批策略");
  await expect(sandbox).toHaveValue("workspace-write");
  await expect(approval).toHaveValue("on-request");
  await expect(page.getByText("采用全局默认", { exact: true })).toBeVisible();

  await sandbox.selectOption("danger-full-access");
  await approval.selectOption("never");
  await expect(
    page.getByText("全部覆盖本次任务", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/减少隔离或审批保护/u)).toBeVisible();

  const prompt = "验证新任务权限覆盖";
  await page.getByPlaceholder("描述你希望 Codex 完成的工作…").fill(prompt);
  await page.getByRole("button", { name: "新建任务" }).click();
  await expect(page.getByRole("heading", { name: prompt })).toBeVisible();

  await page.getByRole("button", { name: "任务设置" }).click();
  const dialog = page.getByRole("dialog", { name: "任务权限与运行设置" });
  await expect(dialog.getByRole("radio", { name: /完全访问/u })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: /从不询问/u })).toBeChecked();
});

test("新任务可在第一轮前选择模型与受支持的推理强度", async ({ page }) => {
  await openScenario(page);

  const model = page.getByLabel("本次任务模型");
  const effort = page.getByLabel("本次任务推理强度");
  await expect(model).toHaveValue("");
  await expect(effort).toHaveValue("");
  await model.selectOption("gpt-5.6-sol");
  await effort.selectOption("ultra");
  await model.selectOption("gpt-5.6-luna");
  await expect(effort).toHaveValue("");
  await effort.selectOption("high");

  const prompt = "验证首轮模型配置";
  await page.getByPlaceholder("描述你希望 Codex 完成的工作…").fill(prompt);
  await page.getByRole("button", { name: "新建任务" }).click();
  await expect(page.getByRole("heading", { name: prompt })).toBeVisible();

  await page.getByRole("button", { name: "任务设置" }).click();
  const dialog = page.getByRole("dialog", { name: "任务权限与运行设置" });
  await dialog.getByText("模型与推理强度", { exact: false }).click();
  await expect(dialog.getByLabel("当前任务模型")).toHaveValue("gpt-5.6-luna");
  await expect(dialog.getByLabel("当前任务推理强度")).toHaveValue("high");
});

test("任务默认跨工作区显示名称，并可按工作区筛选", async ({
  page,
}, testInfo) => {
  await openScenario(page);

  const filter = page.getByLabel("筛选任务工作区");
  await expect(filter).toHaveValue("");
  await expect(page.getByText(/全部工作区 · 已显示 1 个/u)).toBeVisible();
  const welcome = page.locator("[data-task-card]").filter({
    hasText: "欢迎使用 CodexEverywhere",
  });
  await expect(welcome.getByText("Demo", { exact: true })).toBeVisible();

  await navigateTo(page, "/workspaces");
  await page.getByPlaceholder("/public/project").fill("/public/research");
  await page.getByPlaceholder("显示名称（可选）").fill("Research");
  await page.getByRole("button", { name: "添加" }).click();
  await expect(page.getByText("工作区已添加。")).toBeVisible();

  await navigateTo(page, "/tasks");
  await expect(filter.getByRole("option", { name: "Research" })).toBeAttached();
  const newTaskWorkspace = page.getByRole("combobox", {
    name: "新任务工作区",
    exact: true,
  });
  await newTaskWorkspace.selectOption({
    label: "Research",
  });
  const prompt = "验证 Research 工作区筛选";
  await page.getByPlaceholder("描述你希望 Codex 完成的工作…").fill(prompt);
  await page.getByRole("button", { name: "新建任务" }).click();
  await expect(page.getByRole("heading", { name: prompt })).toBeVisible();

  await navigateTo(page, "/tasks");
  const researchTask = page
    .locator("[data-task-card]")
    .filter({ hasText: prompt });
  await expect(
    researchTask.getByText("Research", { exact: true }),
  ).toBeVisible();
  await filter.selectOption({ label: "Research" });
  await expect(page.getByText(/Research · 已显示 1 个/u)).toBeVisible();
  await expect(researchTask).toBeVisible();
  await expect(welcome).toHaveCount(0);
  if (!testInfo.project.name.includes("mobile")) {
    await expect(page.getByText(/最近任务.*Research/u)).toBeVisible();
  }
  await expect(newTaskWorkspace).toHaveValue(await filter.inputValue());

  if (testInfo.project.name.includes("mobile")) {
    await filter.selectOption("");
  } else {
    await page.getByRole("link", { name: "全部", exact: true }).click();
  }
  await expect(filter).toHaveValue("");
  await expect(page.getByText(/全部工作区 · 已显示 2 个/u)).toBeVisible();
  await expect(researchTask).toBeVisible();
  await expect(welcome).toBeVisible();
});

test("新任务的单字段覆盖不会冻结另一项全局默认权限", async ({ page }) => {
  await openScenario(page, "&scenarioDefaultsChange=1");

  const sandbox = page.getByLabel("本次任务 Sandbox");
  const approval = page.getByLabel("本次任务审批策略");
  await approval.selectOption("never");
  await expect(
    page.getByText("部分覆盖本次任务", { exact: true }),
  ).toBeVisible();
  const prompt = "验证按字段继承默认权限";
  await page.getByPlaceholder("描述你希望 Codex 完成的工作…").fill(prompt);
  await page.getByRole("button", { name: "新建任务" }).click();

  await expect(page.getByText(/仍继承的全局权限刚刚发生变化/u)).toBeVisible();
  await expect(sandbox).toHaveValue("read-only");
  await expect(approval).toHaveValue("never");
  await expect(page.getByRole("heading", { name: prompt })).toHaveCount(0);

  await page.getByRole("button", { name: "新建任务" }).click();
  await expect(page.getByRole("heading", { name: prompt })).toBeVisible();
  await page.getByRole("button", { name: "任务设置" }).click();
  const dialog = page.getByRole("dialog", { name: "任务权限与运行设置" });
  await expect(dialog.getByRole("radio", { name: /只读/u })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: /从不询问/u })).toBeChecked();
});

test("采用全局默认时会在创建前复核最新权限", async ({ page }) => {
  await openScenario(page, "&scenarioDefaultsChange=1");

  const sandbox = page.getByLabel("本次任务 Sandbox");
  const prompt = "验证创建前默认权限复核";
  await expect(sandbox).toHaveValue("workspace-write");
  await page.getByPlaceholder("描述你希望 Codex 完成的工作…").fill(prompt);
  await page.getByRole("button", { name: "新建任务" }).click();

  await expect(page.getByText(/仍继承的全局权限刚刚发生变化/u)).toBeVisible();
  await expect(sandbox).toHaveValue("read-only");
  await expect(page.getByText("采用全局默认", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: prompt })).toHaveCount(0);

  await page.getByRole("button", { name: "新建任务" }).click();
  await expect(page.getByRole("heading", { name: prompt })).toBeVisible();
  await page.getByRole("button", { name: "任务设置" }).click();
  const dialog = page.getByRole("dialog", { name: "任务权限与运行设置" });
  await expect(dialog.getByRole("radio", { name: /只读/u })).toBeChecked();
});

test("新任务校验期间锁定请求快照中的全部输入", async ({ page }) => {
  await openScenario(page, "&scenarioPreferenceValidationDelay=1");

  const workspace = page.getByRole("combobox", {
    name: "新任务工作区",
    exact: true,
  });
  const prompt = page.getByPlaceholder("描述你希望 Codex 完成的工作…");
  const sandbox = page.getByLabel("本次任务 Sandbox");
  const title = "验证新任务输入快照";
  await prompt.fill(title);
  await page.getByRole("button", { name: "新建任务" }).click();

  await expect(workspace).toBeDisabled();
  await expect(prompt).toBeDisabled();
  await expect(sandbox).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "正在确认默认权限…" }),
  ).toBeDisabled();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});

test("新任务前置读取失败后可显式恢复且保留已输入请求", async ({ page }) => {
  await openScenario(page, "&scenarioTaskPrerequisiteFailure=1");

  const prompt = page.getByPlaceholder("描述你希望 Codex 完成的工作…");
  await prompt.fill("保留这条尚未提交的请求");
  await expect(
    page.getByText("Scenario preferences are temporarily unavailable"),
  ).toBeVisible();
  const workspace = page.getByRole("combobox", {
    name: "新任务工作区",
    exact: true,
  });
  await expect(workspace).toBeDisabled();

  await page.getByRole("button", { name: "重新读取工作区和默认权限" }).click();
  await expect(page.getByLabel("本次任务 Sandbox")).toHaveValue(
    "workspace-write",
  );
  await expect(workspace).toBeEnabled();
  await expect(prompt).toHaveValue("保留这条尚未提交的请求");
  await expect(page.getByRole("button", { name: "新建任务" })).toBeEnabled();
});

test("任务权限冲突后同步新 revision 并保留用户更改", async ({ page }) => {
  await openScenario(page, "&scenarioSettingsConflict=1");
  await openTaskCard(page, "欢迎使用 CodexEverywhere");

  await page.getByRole("button", { name: "任务设置" }).click();
  const dialog = page.getByRole("dialog", { name: "任务权限与运行设置" });
  const save = dialog.getByRole("button", { name: "保存更改" });
  await dialog.getByRole("radio", { name: /工作区可写/u }).click();
  await dialog.getByRole("radio", { name: /按需询问/u }).click();
  await save.click();

  await expect(
    dialog.getByText(/已读取最新 revision，并在其上保留你的更改/u),
  ).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: /工作区可写/u }),
  ).toBeChecked();
  await expect(dialog.getByRole("radio", { name: /按需询问/u })).toBeChecked();
  await expect(save).toBeEnabled();

  await save.click();
  await expect(
    dialog.getByText("设置已保存，并已应用到当前任务。"),
  ).toBeVisible();
  await expect(save).toBeDisabled();
});

test("工作区支持新增、默认切换和安全移除", async ({ page }) => {
  await openScenario(page);
  await page
    .getByRole("link", { name: /工作区/u })
    .last()
    .click();

  await page.getByPlaceholder("/public/project").fill("/public/new-project");
  await page.getByPlaceholder("显示名称（可选）").fill("New Project");
  await page.getByRole("button", { name: "添加" }).click();
  const added = page
    .locator(".workspace-row")
    .filter({ hasText: "New Project" });
  const original = page.locator(".workspace-row").filter({ hasText: "Demo" });
  await expect(added).toBeVisible();

  await added.getByRole("button", { name: "设为默认" }).click();
  await expect(added.getByText("默认", { exact: true })).toBeVisible();
  await original.getByRole("button", { name: "设为默认" }).click();
  await expect(original.getByText("默认", { exact: true })).toBeVisible();
  await added.getByRole("button", { name: "移除" }).click();
  await expect(added).toHaveCount(0);
});

test("工作区 mutation 成功后列表刷新失败不会被误报为操作失败", async ({
  page,
}) => {
  await openScenario(page, "&scenarioWorkspaceRefreshFailure=1");
  await navigateTo(page, "/workspaces");

  await page.getByPlaceholder("/public/project").fill("/public/recovered");
  await page.getByPlaceholder("显示名称（可选）").fill("Recovered");
  await page.getByRole("button", { name: "添加" }).click();

  await expect(page.getByText("工作区已添加。")).toBeVisible();
  await expect(
    page.getByText(/操作已完成，但工作区列表刷新失败/u),
  ).toBeVisible();
  await expect(page.getByPlaceholder("/public/project")).toHaveValue("");

  await navigateTo(page, "/tasks");
  await navigateTo(page, "/workspaces");
  await expect(
    page.locator(".workspace-row").filter({ hasText: "Recovered" }),
  ).toBeVisible();
});

test("全局设置显式保存，并成为新任务显示的默认权限", async ({ page }) => {
  await openScenario(page);
  await navigateTo(page, "/settings");

  const sandbox = page.getByLabel("默认 Sandbox");
  const save = page.getByRole("button", { name: "保存全局设置" });
  await expect(save).toBeDisabled();
  await sandbox.selectOption("read-only");
  await expect(page.locator("[data-preferences-form]")).toHaveAttribute(
    "data-pwa-draft",
    "true",
  );
  await expect(page.getByText("有未保存的更改")).toBeVisible();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByText("全局设置已保存；新任务将使用这些默认权限。"),
  ).toBeVisible();
  await expect(sandbox).toHaveValue("read-only");
  await expect(save).toBeDisabled();
  await expect(page.locator("[data-preferences-form]")).not.toHaveAttribute(
    "data-pwa-draft",
    "true",
  );
  await expect(page.getByText(/已保存 · revision 1/u)).toBeVisible();

  await navigateTo(page, "/tasks");
  await expect(page.getByLabel("本次任务 Sandbox")).toHaveValue("read-only");
  await expect(page.getByText("采用全局默认", { exact: true })).toBeVisible();
});

test("Codex 版本读取失败不会阻断偏好与身份设置", async ({ page }) => {
  await openScenario(page, "&scenarioCodexVersionFailure=1");
  await navigateTo(page, "/settings");

  await expect(page.getByLabel("默认 Sandbox")).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "添加 Passkey" }),
  ).toBeEnabled();
  await expect(
    page.getByText("Scenario Codex version is temporarily unavailable"),
  ).toBeVisible();
  await expect(page.getByText(/app-server 健康/u)).toBeVisible();
});

test("全局设置已由其他设备应用时直接收口为成功", async ({ page }) => {
  await openScenario(page, "&scenarioPreferencesAlreadyApplied=1");
  await navigateTo(page, "/settings");

  const theme = page.getByLabel("主题");
  const sandbox = page.getByLabel("默认 Sandbox");
  const save = page.getByRole("button", { name: "保存全局设置" });
  await theme.selectOption("dark");
  await sandbox.selectOption("read-only");
  await save.click();

  await expect(
    page.getByText(/其他设备已应用相同设置.*无需再次保存/u),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(page.getByText(/已保存 · revision 1/u)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("全局设置冲突同步失败后锁定旧 revision 并只允许重读", async ({ page }) => {
  await openScenario(page, "&scenarioPreferenceConflictRefreshFailure=1");
  await navigateTo(page, "/settings");

  const sandbox = page.getByLabel("默认 Sandbox");
  await sandbox.selectOption("read-only");
  await page.getByRole("button", { name: "保存全局设置" }).click();

  await expect(page.getByText("同步失败 · 尚未再次提交")).toBeVisible();
  await expect(page.getByText(/设置版本发生冲突.*尚未再次提交/u)).toBeVisible();
  await expect(sandbox).toBeDisabled();
  const retry = page.getByRole("button", { name: "重新同步宿主机设置" });
  await expect(retry).toBeEnabled();

  await retry.click();
  await expect(page.getByText(/已同步最新版本并保留你的改动/u)).toBeVisible();
  await expect(sandbox).toBeEnabled();
  await expect(sandbox).toHaveValue("read-only");
  const save = page.getByRole("button", { name: "保存全局设置" });
  await expect(save).toBeEnabled();

  await save.click();
  await expect(
    page.getByText("全局设置已保存；新任务将使用这些默认权限。"),
  ).toBeVisible();
});

test("管理端覆盖登记、停用、启用、恢复交接和审计", async ({ page }) => {
  await page.goto("/admin?scenario=1");
  await page.getByRole("button", { name: "打开 ScenarioGateway" }).click();

  await page.getByPlaceholder("Unix 用户名").fill("alice");
  await page.getByRole("button", { name: "检查" }).click();
  await expect(page.getByText("符合开通条件")).toBeVisible();
  await page.getByRole("button", { name: "登记用户" }).click();
  await expect(page.getByText("/home/alice", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "停用 Web" }).click();
  await expect(page.getByRole("button", { name: "重新启用" })).toBeVisible();
  await page.getByRole("button", { name: "重新启用" }).click();
  await expect(page.getByRole("button", { name: "停用 Web" })).toBeVisible();
  await page.getByRole("button", { name: "签发恢复交接码" }).click();
  await expect(
    page.getByRole("heading", { name: "alice 的恢复交接码" }),
  ).toBeVisible();
  await expect(page.locator("[data-one-time-secret]")).toContainText(
    "SCENARIO-HANDOFF-CODE",
  );
  await page.getByRole("button", { name: "我已安全交接" }).click();
  await expect(page.getByText("admin/user/recovery/start")).toBeVisible();
});

test("390px 视口显示移动端主导航", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "只在移动端项目验证");
  await page.goto("/?scenario=1");
  await page.getByRole("button", { name: "打开 ScenarioGateway" }).click();

  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { name: "任务" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "设置" })).toBeVisible();
});

test("长会话分页、首开滚底、阅读保护与对话大纲协同工作", async ({ page }) => {
  await openScenario(page, "&scenarioLongConversation=1");
  await openTaskCard(page, "长会话分页与大纲");

  const timeline = page.locator(".timeline");
  await expect(timeline.locator(".timeline-item")).toHaveCount(50);
  await expect
    .poll(() => timelineDistanceFromBottom(timeline))
    .toBeLessThanOrEqual(2);

  await expect(
    page.getByText("SCENARIO_LARGE_OUTPUT_SENTINEL", { exact: true }),
  ).toHaveCount(0);
  await page.getByText("查看命令输出", { exact: true }).click();
  await expect(
    page.getByText("SCENARIO_LARGE_OUTPUT_SENTINEL", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: /打开对话大纲/u }).click();
  const outline = page.getByRole("dialog", { name: "对话大纲" });
  await expect(outline).toBeVisible();
  await expect(outline.getByText("当前已加载 24 条请求")).toBeVisible();
  await expect(outline.getByText("历史请求 47", { exact: true })).toBeVisible();
  await expect(outline.getByText("历史请求 01", { exact: true })).toHaveCount(
    0,
  );

  const anchorBeforePagination = await firstVisibleTimelineAnchor(timeline);
  await outline.getByRole("button", { name: "加载更早大纲" }).click();
  await expect(timeline.locator(".timeline-item")).toHaveCount(100);
  await expect
    .poll(async () => {
      const anchorAfterPagination = await firstVisibleTimelineAnchor(timeline);
      if (anchorAfterPagination.id !== anchorBeforePagination.id) {
        return Number.POSITIVE_INFINITY;
      }
      return Math.abs(
        anchorAfterPagination.offset - anchorBeforePagination.offset,
      );
    })
    .toBeLessThanOrEqual(TIMELINE_ANCHOR_TOLERANCE_PX);
  await expect(outline.getByText("当前已加载 49 条请求")).toBeVisible();
  await outline.getByText("历史请求 22", { exact: true }).click();
  await expect(outline).toHaveCount(0);
  await expect(
    timeline.getByText("历史请求 22", { exact: true }),
  ).toBeInViewport();
  await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();

  await page.getByRole("button", { name: "回到最新" }).click();
  await expect
    .poll(() => timelineDistanceFromBottom(timeline))
    .toBeLessThanOrEqual(2);

  await timeline.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();
  const detachedScrollTop = await timeline.evaluate(
    (element) => element.scrollTop,
  );
  await page.getByLabel("给 Codex 的消息").fill("阅读旧消息时继续执行");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expectScenarioReply(page);
  await expect
    .poll(() => timeline.evaluate((element) => element.scrollTop))
    .toBeLessThanOrEqual(detachedScrollTop + 2);
  await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();
});

test("长文件路径只在路径区域内部横向滚动", async ({ page }) => {
  await page.goto("/");
  const path =
    "/public/demo/a/very/long/workspace/path/with_a_single_unbroken_filename_that_must_remain_fully_readable_without_expanding_the_file_change_card.ts";
  await page.setContent(`
    <link rel="stylesheet" href="/src/v4/styles/global.css" />
    <main class="timeline">
      <article class="timeline-item type-file-change">
        <ul class="file-change-list">
          <li>
            <div>
              <code tabindex="0" title="${path}">${path}</code>
              <span>已修改</span>
            </div>
            <details class="timeline-details">
              <summary>查看差异</summary>
              <pre>+changed</pre>
            </details>
          </li>
        </ul>
      </article>
    </main>
  `);

  const timeline = page.locator(".timeline");
  const card = page.locator(".timeline-item");
  const list = page.locator(".file-change-list");
  const pathRegion = list.locator("code");
  await expect(list).toHaveCSS("grid-template-columns", /\d+(?:\.\d+)?px/u);

  const [timelineBox, cardBox, listBox] = await Promise.all([
    timeline.boundingBox(),
    card.boundingBox(),
    list.boundingBox(),
  ]);
  expect(timelineBox).not.toBeNull();
  expect(cardBox).not.toBeNull();
  expect(listBox).not.toBeNull();
  expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(
    cardBox!.x + cardBox!.width,
  );
  await expect
    .poll(() => timeline.evaluate((element) => element.scrollWidth))
    .toBeLessThanOrEqual(timelineBox!.width);
  await expect
    .poll(() =>
      pathRegion.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    )
    .toBe(true);
  await pathRegion.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(() => pathRegion.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await expect(pathRegion).toHaveCSS("overflow-x", "auto");
  await expect(pathRegion).toHaveAttribute("title", path);
});

async function openScenario(
  page: import("@playwright/test").Page,
  extraQuery = "",
) {
  await page.goto(`/?scenario=1${extraQuery}`);
  await page.getByRole("button", { name: "打开 ScenarioGateway" }).click();
  await expect(
    page.getByRole("heading", { name: "任务", exact: true }),
  ).toBeVisible();
}

async function expectScenarioReply(page: import("@playwright/test").Page) {
  await expect(
    page.getByText(
      "Scenario 回复已完成。真实连接会在同一位置呈现 Codex 流式事件。",
      { exact: true },
    ),
  ).toBeVisible();
}

async function createTask(
  page: import("@playwright/test").Page,
  prompt: string,
) {
  await page.getByPlaceholder("描述你希望 Codex 完成的工作…").fill(prompt);
  await page.getByRole("button", { name: "新建任务" }).click();
  await expect(page.getByRole("heading", { name: prompt })).toBeVisible();
}

async function navigateTo(page: import("@playwright/test").Page, href: string) {
  await page.locator(`a[href="${href}"]:visible`).first().click();
}

async function openTaskCard(
  page: import("@playwright/test").Page,
  title: string,
) {
  await page
    .locator("[data-task-grid] [data-task-card]")
    .filter({ hasText: title })
    .click();
}

async function openTaskActions(page: import("@playwright/test").Page) {
  await page.locator('summary[aria-label="更多任务操作"]').click();
}

async function timelineDistanceFromBottom(
  timeline: import("@playwright/test").Locator,
): Promise<number> {
  return timeline.evaluate(
    (element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop,
  );
}

async function firstVisibleTimelineAnchor(
  timeline: import("@playwright/test").Locator,
): Promise<{ readonly id: string; readonly offset: number }> {
  return timeline.evaluate((element) => {
    const timelineRect = element.getBoundingClientRect();
    const target = [
      ...element.querySelectorAll<HTMLElement>("[data-timeline-item-id]"),
    ].find(
      (candidate) =>
        candidate.getBoundingClientRect().bottom >= timelineRect.top + 1,
    );
    if (target?.dataset.timelineItemId === undefined) {
      throw new Error("Timeline has no visible stable item anchor");
    }
    return {
      id: target.dataset.timelineItemId,
      offset: target.getBoundingClientRect().top - timelineRect.top,
    };
  });
}
