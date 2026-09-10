import { expect, test } from "@playwright/test";

test("旁支独立提问、收起恢复、追加主草稿和删除", async ({ page }, testInfo) => {
  await page.goto("/?scenario=1");
  await page.getByRole("button", { name: "打开 ScenarioGateway" }).click();
  await page
    .getByPlaceholder("描述你希望 Codex 完成的工作…")
    .fill("旁支体验验收主任务");
  await page.getByRole("button", { name: "新建任务" }).click();
  await expect(
    page.getByText(
      "Scenario 回复已完成。真实连接会在同一位置呈现 Codex 流式事件。",
    ),
  ).toBeVisible();
  const mainInput = page.getByLabel("给 Codex 的消息");
  await mainInput.fill("/side 解释刚才方案的取舍");
  await mainInput.press("Enter");
  const side = page.getByRole("complementary", { name: "旁支问答" });
  await expect(side).toBeVisible();
  await expect(
    side.getByText("解释刚才方案的取舍", { exact: true }),
  ).toBeVisible();
  await expect(
    side.getByText(
      "Scenario 回复已完成。真实连接会在同一位置呈现 Codex 流式事件。",
    ),
  ).toBeVisible();
  await expect(
    side.getByText("旁支体验验收主任务", { exact: true }),
  ).toHaveCount(0);
  await side.getByLabel("旁支问题").fill("保留的旁支草稿");
  await side.getByRole("button", { name: "收起 / 返回" }).click();
  await expect(side).toHaveCount(0);
  await expect(mainInput).toBeVisible();
  await mainInput.fill("原来的主任务草稿");
  await page.getByRole("button", { name: "继续旁支问答 /side" }).click();
  await expect(side.getByLabel("旁支问题")).toHaveValue("保留的旁支草稿");
  await side.getByRole("button", { name: "带回主对话", exact: true }).click();
  await expect(
    side.getByRole("button", { name: "已追加到主对话草稿" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  if (testInfo.project.name.startsWith("mobile"))
    await expect(mainInput).toBeHidden();
  else await expect(mainInput).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("side-panel.png"),
    fullPage: true,
  });
  await side.getByRole("button", { name: "结束并删除" }).click();
  await expect(side).toHaveCount(0);
  await expect(mainInput).toHaveValue(/^原来的主任务草稿\n\n旁支问答参考：/u);
  await expect(
    page
      .locator(".conversation-main .timeline")
      .getByText("解释刚才方案的取舍", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "旁支问答 /side", exact: true })
    .click();
  await expect(side.getByLabel("旁支问题")).toHaveValue("");
  await expect(
    side.getByText("解释刚才方案的取舍", { exact: true }),
  ).toHaveCount(0);
});

test("主任务等待审批时旁支仍可提问，停止旁支不影响主任务", async ({ page }) => {
  await page.goto("/?scenario=1");
  await page.getByRole("button", { name: "打开 ScenarioGateway" }).click();
  await page
    .getByPlaceholder("描述你希望 Codex 完成的工作…")
    .fill("并行旁支主任务");
  await page.getByRole("button", { name: "新建任务" }).click();
  await expect(
    page.getByText(
      "Scenario 回复已完成。真实连接会在同一位置呈现 Codex 流式事件。",
    ),
  ).toBeVisible();
  const mainInput = page.getByLabel("给 Codex 的消息");
  await mainInput.fill("[approval] 主任务等待批准");
  await mainInput.press("Enter");
  await expect(page.getByText("允许 Codex 执行命令？")).toBeVisible();
  await mainInput.fill("/side 解释为什么需要这项审批");
  await mainInput.press("Enter");
  const side = page.getByRole("complementary", { name: "旁支问答" });
  await expect(side.getByText("主任务 · 等待你的操作")).toBeVisible();
  await expect(
    side.getByText(
      "Scenario 回复已完成。真实连接会在同一位置呈现 Codex 流式事件。",
    ),
  ).toBeVisible();
  await side
    .getByLabel("旁支问题")
    .fill("[approval] synthetic unsupported side tool");
  await side.getByLabel("旁支问题").press("Enter");
  await expect(
    side.getByText("旁支请求了不支持的执行操作；请结束并删除旁支。"),
  ).toBeVisible();
  await expect(side.getByText("允许 Codex 执行命令？")).toHaveCount(0);
  await side.getByRole("button", { name: "停止并删除" }).click();
  await expect(side).toHaveCount(0);
  await expect(page.getByText("允许 Codex 执行命令？")).toBeVisible();
  await expect(
    page.getByText("[approval] 主任务等待批准", { exact: true }),
  ).toBeVisible();
});
