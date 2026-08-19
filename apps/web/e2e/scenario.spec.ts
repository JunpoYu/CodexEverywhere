import { expect, test } from "@playwright/test";

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
  await page.getByRole("button", { name: "加入 Queue" }).click();
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
    page.locator(".task-grid .task-card").filter({
      hasText: "任务生命周期新名称",
    }),
  ).toHaveCount(0);
});

test("任务权限可连续保存，并始终显示权威结果", async ({ page }) => {
  await openScenario(page);
  await openTaskCard(page, "欢迎使用 CodexEverywhere");

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

test("个人偏好保存后提供明确反馈", async ({ page }) => {
  await openScenario(page);
  await navigateTo(page, "/settings");

  const sandbox = page.getByLabel("默认 Sandbox");
  await sandbox.selectOption("read-only");
  await expect(
    page.getByText("偏好设置已保存。新任务会使用更新后的默认值。"),
  ).toBeVisible();
  await expect(sandbox).toHaveValue("read-only");

  await sandbox.selectOption("workspace-write");
  await expect(sandbox).toHaveValue("workspace-write");
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

async function openScenario(page: import("@playwright/test").Page) {
  await page.goto("/?scenario=1");
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
    .locator(".task-grid .task-card")
    .filter({ hasText: title })
    .click();
}

async function openTaskActions(page: import("@playwright/test").Page) {
  await page.locator('summary[aria-label="更多任务操作"]').click();
}
