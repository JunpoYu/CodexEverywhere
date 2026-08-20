import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  GatewayRemoteError,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import { useActorState } from "../../actors/use-actor.js";
import { durableMutation } from "../../gateway/durable-mutation.js";
import { queryOptions } from "../../gateway/gateway-port.js";
import { Icon } from "../components/Icon.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { useRuntime } from "../runtime-context.js";

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
  const [sandbox, setSandbox] = useState<Preferences["sandbox"]>();
  const [approvalPolicy, setApprovalPolicy] =
    useState<Preferences["approvalPolicy"]>();
  const [permissionsOverridden, setPermissionsOverridden] = useState(false);
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
        setSandbox(preferences.sandbox);
        setApprovalPolicy(preferences.approvalPolicy);
        setPermissionsOverridden(false);
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
    const selectedSandbox = sandbox;
    const selectedApprovalPolicy = approvalPolicy;
    const displayedDefaults = defaults;
    const usesDefaults = !permissionsOverridden;
    if (
      workspaceId.length === 0 ||
      prompt.trim().length === 0 ||
      displayedDefaults === undefined ||
      selectedSandbox === undefined ||
      selectedApprovalPolicy === undefined
    ) {
      return;
    }
    setError(undefined);
    setWarning(undefined);
    let effectiveSandbox = selectedSandbox;
    let effectiveApprovalPolicy = selectedApprovalPolicy;
    let expectedPreferencesRevision: number | undefined;
    try {
      if (usesDefaults) {
        setStarting("validating");
        const latest = await loadPreferences(runtime.gateway);
        const changed = defaultPermissionsChanged(displayedDefaults, latest);
        adoptDefaultPermissions(latest);
        if (changed) {
          setWarning(
            "全局默认权限刚刚发生变化，已更新本表单。请确认新的权限后再次创建任务。",
          );
          return;
        }
        effectiveSandbox = latest.sandbox;
        effectiveApprovalPolicy = latest.approvalPolicy;
        expectedPreferencesRevision = latest.revision;
      }
      setStarting("submitting");
      const result = await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "thread/start",
        payload: {
          version: 1,
          workspaceId,
          prompt: prompt.trim(),
          ...(expectedPreferencesRevision === undefined
            ? {}
            : { expectedPreferencesRevision }),
          settings: {
            sandbox: effectiveSandbox,
            approvalPolicy: effectiveApprovalPolicy,
          },
        },
        onOutcomeUnknown: () => setStarting("reconciling"),
      });
      runtime.tasks.dispatch({ type: "LOAD" });
      navigate(`/tasks/${encodeURIComponent(result.thread.id)}`);
    } catch (reason) {
      if (
        usesDefaults &&
        reason instanceof GatewayRemoteError &&
        reason.code === "REVISION_CONFLICT"
      ) {
        setStarting("validating");
        try {
          const latest = await loadPreferences(runtime.gateway);
          const changed =
            latest.sandbox !== effectiveSandbox ||
            latest.approvalPolicy !== effectiveApprovalPolicy;
          adoptDefaultPermissions(latest);
          setWarning(
            changed
              ? "创建前全局默认权限再次发生变化，任务尚未创建。请确认新的权限后重试。"
              : "创建前全局设置发生了并发更新，任务尚未创建；当前权限未变化，可以安全重试。",
          );
        } catch (refreshReason) {
          setError(
            `创建前检测到全局设置冲突，但同步失败：${errorMessage(refreshReason)}`,
          );
        }
      } else {
        setError(errorMessage(reason));
      }
    } finally {
      setStarting("idle");
    }
  };

  const adoptDefaultPermissions = (latest: Preferences) => {
    setDefaults(latest);
    setSandbox(latest.sandbox);
    setApprovalPolicy(latest.approvalPolicy);
    setPermissionsOverridden(false);
  };
  const updateSandbox = (next: Preferences["sandbox"]) => {
    setSandbox(next);
    setPermissionsOverridden(
      defaults !== undefined &&
        (next !== defaults.sandbox ||
          approvalPolicy !== defaults.approvalPolicy),
    );
    setWarning(undefined);
  };
  const updateApprovalPolicy = (next: Preferences["approvalPolicy"]) => {
    setApprovalPolicy(next);
    setPermissionsOverridden(
      defaults !== undefined &&
        (sandbox !== defaults.sandbox || next !== defaults.approvalPolicy),
    );
    setWarning(undefined);
  };
  const permissionsOverrideDefaults = permissionsOverridden;
  const permissionsReady =
    defaults !== undefined &&
    sandbox !== undefined &&
    approvalPolicy !== undefined;

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

      <form className="new-task-card" onSubmit={(event) => void start(event)}>
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
                  ? "仅覆盖本次任务"
                  : "采用全局默认"}
              </span>
              <small>
                {permissionsReady
                  ? `${sandboxLabel(sandbox)} · ${approvalPolicyLabel(approvalPolicy)}`
                  : "正在读取全局默认权限…"}
              </small>
              <div>
                <button
                  disabled={!permissionsOverrideDefaults}
                  type="button"
                  onClick={() => {
                    if (defaults === undefined) return;
                    adoptDefaultPermissions(defaults);
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

export function defaultPermissionsChanged(
  displayed: Pick<Preferences, "sandbox" | "approvalPolicy">,
  latest: Pick<Preferences, "sandbox" | "approvalPolicy">,
): boolean {
  return (
    displayed.sandbox !== latest.sandbox ||
    displayed.approvalPolicy !== latest.approvalPolicy
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "任务创建失败";
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
