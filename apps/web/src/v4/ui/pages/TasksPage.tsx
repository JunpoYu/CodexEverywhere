import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  GatewayRemoteError,
  THREAD_START_INPUT_VERSION,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import { useActorState } from "../../actors/use-actor.js";
import { durableMutation } from "../../gateway/durable-mutation.js";
import { queryOptions } from "../../gateway/gateway-port.js";
import { Icon } from "../components/Icon.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { useRuntime } from "../runtime-context.js";
import {
  defaultPermissionDraft,
  inheritedPermissionsChanged,
  inheritsAnyPermission,
  overrideApprovalPolicy,
  overrideSandbox,
  permissionOverrideCount,
  rebaseInheritedPermissions,
  threadStartPermissionOverrides,
  type NewTaskPermissionDraft,
} from "./new-task-permissions.js";

type Preferences = OutputOf<"preferences/read">;

export function TasksPage() {
  const runtime = useRuntime();
  const tasks = useActorState(runtime.tasks);
  const [workspaces, setWorkspaces] = useState<
    Awaited<ReturnType<typeof loadWorkspaces>>
  >([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [defaults, setDefaults] = useState<Preferences>();
  const [permissionDraft, setPermissionDraft] =
    useState<NewTaskPermissionDraft>();
  const [starting, setStarting] = useState<
    "idle" | "validating" | "submitting" | "reconciling"
  >("idle");
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const navigate = useNavigate();

  useEffect(() => {
    const currentTasks = runtime.tasks.getSnapshot();
    if (
      currentTasks.status !== "loading" &&
      currentTasks.status !== "paginating"
    ) {
      runtime.refreshTasks();
    }
    let active = true;
    void Promise.all([
      loadWorkspaces(runtime.gateway),
      loadPreferences(runtime.gateway),
    ])
      .then(([items, preferences]) => {
        if (!active) return;
        setWorkspaces(items);
        setWorkspaceId(
          items.find((workspace) => workspace.isDefault)?.id ??
            items[0]?.id ??
            "",
        );
        setDefaults(preferences);
        setPermissionDraft(defaultPermissionDraft(preferences));
      })
      .catch((reason) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : "无法读取新任务所需的工作区和默认权限",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [runtime]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    const submittedDraft = permissionDraft;
    const displayedDefaults = defaults;
    if (
      workspaceId.length === 0 ||
      prompt.trim().length === 0 ||
      displayedDefaults === undefined ||
      submittedDraft === undefined
    ) {
      return;
    }
    const inheritsPermissions = inheritsAnyPermission(submittedDraft);
    setError(undefined);
    setWarning(undefined);
    let validatedDefaults = displayedDefaults;
    try {
      if (inheritsPermissions) {
        setStarting("validating");
        const latest = await loadPreferences(runtime.gateway);
        const changed = inheritedPermissionsChanged(
          displayedDefaults,
          latest,
          submittedDraft,
        );
        adoptLatestDefaults(latest, submittedDraft);
        if (changed) {
          setWarning(
            "本次任务仍继承的全局权限刚刚发生变化，已更新表单；你的单次覆盖保持不变。请确认后再次创建。",
          );
          return;
        }
        validatedDefaults = latest;
      }
      setStarting("submitting");
      const result = await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "thread/start",
        payload: {
          version: THREAD_START_INPUT_VERSION,
          workspaceId,
          prompt: prompt.trim(),
          expectedPreferencesRevision: validatedDefaults.revision,
          settings: threadStartPermissionOverrides(submittedDraft),
        },
        onOutcomeUnknown: () => setStarting("reconciling"),
      });
      runtime.tasks.dispatch({ type: "LOAD" });
      navigate(`/tasks/${encodeURIComponent(result.thread.id)}`);
    } catch (reason) {
      if (
        inheritsPermissions &&
        reason instanceof GatewayRemoteError &&
        reason.code === "REVISION_CONFLICT"
      ) {
        setStarting("validating");
        try {
          const latest = await loadPreferences(runtime.gateway);
          const changed = inheritedPermissionsChanged(
            validatedDefaults,
            latest,
            submittedDraft,
          );
          adoptLatestDefaults(latest, submittedDraft);
          setWarning(
            changed
              ? "创建前仍继承的全局权限再次发生变化，任务尚未创建；单次覆盖已保留，请确认后重试。"
              : "创建前全局设置发生了并发更新，任务尚未创建；当前权限未变化，可以安全重试。",
          );
        } catch (refreshReason) {
          setError(
            `创建前检测到全局设置冲突，但同步失败：${errorMessage(refreshReason)}`,
          );
        }
      } else if (
        reason instanceof GatewayRemoteError &&
        reason.code === "INVALID_INPUT"
      ) {
        setError("宿主机 Agent 不支持新版任务创建协议，请先升级 Agent。");
      } else {
        setError(errorMessage(reason));
      }
    } finally {
      setStarting("idle");
    }
  };

  const adoptLatestDefaults = (
    latest: Preferences,
    draft: NewTaskPermissionDraft,
  ) => {
    setDefaults(latest);
    setPermissionDraft(rebaseInheritedPermissions(draft, latest));
  };
  const updateSandbox = (next: Preferences["sandbox"]) => {
    setPermissionDraft((current) =>
      current === undefined ? current : overrideSandbox(current, next),
    );
    setWarning(undefined);
  };
  const updateApprovalPolicy = (next: Preferences["approvalPolicy"]) => {
    setPermissionDraft((current) =>
      current === undefined ? current : overrideApprovalPolicy(current, next),
    );
    setWarning(undefined);
  };
  const sandbox = permissionDraft?.sandbox.value;
  const approvalPolicy = permissionDraft?.approvalPolicy.value;
  const overrideCount =
    permissionDraft === undefined
      ? 0
      : permissionOverrideCount(permissionDraft);
  const permissionsOverrideDefaults = overrideCount > 0;
  const permissionsReady =
    defaults !== undefined && permissionDraft !== undefined;

  return (
    <main className="page tasks-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Codex 任务中心</p>
          <h1>任务</h1>
          <p>任务历史和执行状态直接来自 Codex app-server。</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            onClick={() =>
              runtime.tasks.dispatch({
                type: "LOAD",
                archived: !tasks.archived,
              })
            }
          >
            {tasks.archived ? "查看当前任务" : "查看已归档"}
          </button>
          <button
            disabled={tasks.status === "loading"}
            type="button"
            onClick={() =>
              runtime.tasks.dispatch({ type: "LOAD", archived: tasks.archived })
            }
          >
            <Icon name="refresh" />
            刷新
          </button>
        </div>
      </header>

      <form
        className="new-task-card"
        data-pwa-draft={overrideCount > 0 ? "true" : undefined}
        onSubmit={(event) => void start(event)}
      >
        <label className="new-task-field">
          <span>工作区</span>
          <select
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.label}
              </option>
            ))}
          </select>
        </label>
        <label className="new-task-field">
          <span>新任务请求</span>
          <textarea
            rows={3}
            placeholder="描述你希望 Codex 完成的工作…"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <fieldset
          className="new-task-permissions"
          disabled={starting !== "idle" || !permissionsReady}
        >
          <legend>本次任务权限</legend>
          <div className="new-task-permission-grid">
            <label>
              <span>Sandbox</span>
              <select
                aria-label="本次任务 Sandbox"
                value={sandbox ?? ""}
                onChange={(event) =>
                  updateSandbox(event.target.value as Preferences["sandbox"])
                }
              >
                <option value="read-only">只读</option>
                <option value="workspace-write">工作区可写</option>
                <option value="danger-full-access">完全访问</option>
              </select>
            </label>
            <label>
              <span>审批策略</span>
              <select
                aria-label="本次任务审批策略"
                value={approvalPolicy ?? ""}
                onChange={(event) =>
                  updateApprovalPolicy(
                    event.target.value as Preferences["approvalPolicy"],
                  )
                }
              >
                <option value="untrusted">不信任</option>
                <option value="on-request">按需询问</option>
                <option value="never">从不询问</option>
              </select>
            </label>
            <div className="new-task-permission-summary" role="status">
              <span
                className={`state-pill ${permissionsOverrideDefaults ? "waiting-input" : ""}`}
              >
                {permissionsOverrideDefaults
                  ? overrideCount === 2
                    ? "全部覆盖本次任务"
                    : "部分覆盖本次任务"
                  : "采用全局默认"}
              </span>
              <small>
                {permissionDraft !== undefined
                  ? `${sandboxLabel(permissionDraft.sandbox.value)}${permissionSourceLabel(permissionDraft.sandbox.source)} · ${approvalPolicyLabel(permissionDraft.approvalPolicy.value)}${permissionSourceLabel(permissionDraft.approvalPolicy.source)}`
                  : "正在读取全局默认权限…"}
              </small>
              <div>
                <button
                  disabled={!permissionsOverrideDefaults}
                  type="button"
                  onClick={() => {
                    if (defaults === undefined) return;
                    setPermissionDraft(defaultPermissionDraft(defaults));
                    setWarning(undefined);
                  }}
                >
                  恢复全局默认
                </button>
                <Link to="/settings">修改全局默认</Link>
              </div>
            </div>
          </div>
          {sandbox === "danger-full-access" || approvalPolicy === "never" ? (
            <p className="new-task-permission-warning">
              当前组合会减少隔离或审批保护，请确认这是本次任务需要的权限。
            </p>
          ) : null}
        </fieldset>
        <button
          className="primary new-task-submit"
          type="submit"
          disabled={
            starting !== "idle" ||
            workspaceId.length === 0 ||
            prompt.trim().length === 0 ||
            !permissionsReady
          }
        >
          {starting === "reconciling"
            ? "正在确认创建结果…"
            : starting === "submitting"
              ? "正在创建…"
              : starting === "validating"
                ? "正在确认默认权限…"
                : "新建任务"}
        </button>
      </form>
      {starting === "reconciling" ? (
        <StatusMessage tone="warning">
          连接中断，正在按 operation key 查询宿主机结果；不会重复创建任务。
        </StatusMessage>
      ) : null}
      {warning === undefined ? null : (
        <StatusMessage tone="warning">{warning}</StatusMessage>
      )}
      {error === undefined ? null : (
        <StatusMessage tone="error">{error}</StatusMessage>
      )}

      {tasks.status === "failed" ? (
        <StatusMessage tone="error">
          {tasks.error ?? "任务列表读取失败"}
        </StatusMessage>
      ) : null}

      <section
        aria-label={tasks.archived ? "已归档任务" : "当前任务"}
        className="task-grid"
        aria-busy={tasks.status === "loading"}
      >
        {tasks.tasks.map((task) => (
          <Link
            className="task-card"
            key={task.id}
            to={`/tasks/${encodeURIComponent(task.id)}`}
          >
            <div>
              <i className={`task-dot ${task.state}`} />
              <span>{stateLabel(task.state)}</span>
            </div>
            <h2>{task.title || "未命名任务"}</h2>
            <p>{new Date(task.updatedAt).toLocaleString("zh-CN")}</p>
          </Link>
        ))}
        {tasks.status === "loading" && tasks.tasks.length === 0 ? (
          <div className="empty-state">
            <strong>正在读取任务…</strong>
            <span>历史较多时，Codex app-server 首次索引可能需要片刻。</span>
          </div>
        ) : tasks.status === "ready" && tasks.tasks.length === 0 ? (
          <div className="empty-state">
            <strong>{tasks.archived ? "没有已归档任务" : "还没有任务"}</strong>
            <span>
              {tasks.archived
                ? "归档后的任务会显示在这里。"
                : "从上方输入第一条请求。"}
            </span>
          </div>
        ) : null}
      </section>
      {tasks.hasMore ? (
        <button
          disabled={tasks.status === "paginating"}
          type="button"
          onClick={() => runtime.tasks.dispatch({ type: "MORE" })}
        >
          {tasks.status === "paginating" ? "正在加载…" : "加载更多"}
        </button>
      ) : null}
    </main>
  );
}

async function loadWorkspaces(
  gateway: import("../../gateway/gateway-port.js").GatewayPort,
) {
  return (
    await gateway.request("workspace/list", { version: 1 }, queryOptions())
  ).workspaces;
}

async function loadPreferences(
  gateway: import("../../gateway/gateway-port.js").GatewayPort,
) {
  return gateway.request("preferences/read", { version: 1 }, queryOptions());
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "任务创建失败";
}

function permissionSourceLabel(source: "default" | "override"): string {
  return source === "default" ? "（默认）" : "（本次）";
}

function sandboxLabel(value: Preferences["sandbox"]): string {
  return value === "read-only"
    ? "只读"
    : value === "danger-full-access"
      ? "完全访问"
      : "工作区可写";
}

function approvalPolicyLabel(value: Preferences["approvalPolicy"]): string {
  return value === "untrusted"
    ? "不信任"
    : value === "never"
      ? "从不询问"
      : "按需询问";
}

function stateLabel(state: string): string {
  return state === "running"
    ? "运行中"
    : state === "waiting-input"
      ? "等待操作"
      : state === "failed"
        ? "失败"
        : "空闲";
}
