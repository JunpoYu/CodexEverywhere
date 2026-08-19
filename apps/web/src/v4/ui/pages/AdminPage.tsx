import { useState, type FormEvent } from "react";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import { useActorState } from "../../actors/use-actor.js";
import { durableMutation } from "../../gateway/durable-mutation.js";
import { mutationOptions, queryOptions } from "../../gateway/gateway-port.js";
import { Icon } from "../components/Icon.js";
import { ModalDialog } from "../components/ModalDialog.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { useAdminRuntime } from "../runtime-context.js";

type Inspection = OutputOf<"admin/user/inspect">;
type AdminUser = NonNullable<Inspection["user"]>;

export function AdminPage() {
  const runtime = useAdminRuntime();
  const admin = useActorState(runtime.admin);
  const [username, setUsername] = useState("");
  const [inspection, setInspection] = useState<Inspection>();
  const [handoff, setHandoff] = useState<{
    readonly username: string;
    readonly code: string;
    readonly expiresAt: string;
  }>();
  const [error, setError] = useState<string>();

  const inspect = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      setInspection(
        await runtime.gateway.request(
          "admin/user/inspect",
          { version: 1, username },
          queryOptions(),
        ),
      );
    } catch (reason) {
      setError(message(reason));
    }
  };

  const register = async () => {
    setError(undefined);
    runtime.admin.dispatch({ type: "MUTATING" });
    try {
      const result = await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "admin/user/register",
        payload: { version: 1, username },
      });
      setInspection({ version: 1, eligible: true, user: result.user });
    } catch (reason) {
      setError(message(reason));
    } finally {
      runtime.admin.dispatch({ type: "LOAD" });
    }
  };

  return (
    <div className="admin-shell">
      <header className="topbar">
        <div className="brand-lockup compact">
          <span className="brand-mark">CE</span>
          <div>
            <strong>CodexEverywhere</strong>
            <small>HOST ADMIN</small>
          </div>
        </div>
        <button type="button" onClick={() => location.assign("/hosts")}>
          退出
        </button>
      </header>
      <aside>
        <h2>管理边界</h2>
        <p>
          只管理现有 SSH 用户的 Web 访问和恢复；不能读取用户工作区、任务或 Codex
          凭据。
        </p>
      </aside>
      <main aria-busy={admin.status === "mutating"} className="page">
        <header className="page-heading">
          <div>
            <p className="eyebrow">宿主机控制面</p>
            <h1>{admin.host?.serverName ?? "宿主机管理"}</h1>
          </div>
          <button
            disabled={admin.status === "mutating"}
            onClick={() => runtime.admin.dispatch({ type: "LOAD" })}
          >
            <Icon name="refresh" />
            刷新
          </button>
        </header>
        {admin.host ? (
          <section className="metric-grid">
            <Metric label="登记用户" value={admin.host.managedUsers} />
            <Metric label="已启用" value={admin.host.enabledUsers} />
            <Metric label="已停用" value={admin.host.disabledUsers} />
            <Metric label="待移除" value={admin.host.pendingRemovals} />
          </section>
        ) : null}
        <section className="admin-panel">
          <h2>精确检查 NSS 用户</h2>
          <form className="inline-form" onSubmit={inspect}>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Unix 用户名"
              required
            />
            <button disabled={admin.status === "mutating"} type="submit">
              检查
            </button>
          </form>
          {inspection ? (
            <div className="inspection-result">
              <strong>
                {inspection.eligible ? "符合开通条件" : "不可开通"}
              </strong>
              {inspection.reason ? <p>{inspection.reason}</p> : null}
              {inspection.eligible && inspection.user === undefined ? (
                <button
                  className="primary"
                  disabled={admin.status === "mutating"}
                  type="button"
                  onClick={() => void register()}
                >
                  登记用户
                </button>
              ) : null}
              {inspection.user ? (
                <UserActions
                  user={inspection.user}
                  onChanged={(user) =>
                    setInspection({ version: 1, eligible: true, user })
                  }
                  onHandoff={(value) => setHandoff(value)}
                />
              ) : null}
            </div>
          ) : null}
        </section>
        <section className="admin-panel">
          <h2>安全审计</h2>
          <div className="audit-list">
            {admin.audit.map((event) => (
              <article key={event.id}>
                <span className={event.result}>
                  {event.result === "succeeded" ? "成功" : "失败"}
                </span>
                <div>
                  <strong>{event.action}</strong>
                  <small>
                    {event.targetUsername ?? event.actor} ·{" "}
                    {new Date(event.createdAt).toLocaleString("zh-CN")}
                  </small>
                </div>
              </article>
            ))}
          </div>
        </section>
        {(error ?? admin.error) ? (
          <StatusMessage tone="error">{error ?? admin.error}</StatusMessage>
        ) : null}
      </main>
      {handoff === undefined ? null : (
        <ModalDialog className="ce-dialog" aria-labelledby="handoff-title">
          <h2 id="handoff-title">{handoff.username} 的恢复交接码</h2>
          <p>
            仅在完成线下身份核验后交给用户。有效期至{" "}
            {new Date(handoff.expiresAt).toLocaleString("zh-CN")}。
          </p>
          <pre data-one-time-secret>{handoff.code}</pre>
          <div className="dialog-actions">
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(handoff.code)}
            >
              复制
            </button>
            <button
              className="primary"
              type="button"
              onClick={() => setHandoff(undefined)}
            >
              我已安全交接
            </button>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}

function UserActions(input: {
  readonly user: AdminUser;
  readonly onChanged: (user: AdminUser) => void;
  readonly onHandoff: (value: {
    readonly username: string;
    readonly code: string;
    readonly expiresAt: string;
  }) => void;
}) {
  const runtime = useAdminRuntime();
  const admin = useActorState(runtime.admin);
  const [removeAfter, setRemoveAfter] = useState(defaultRemovalTime());
  const [error, setError] = useState<string>();

  const mutate = async (
    method:
      "admin/user/disable" | "admin/user/enable" | "admin/user/removal/cancel",
  ) => {
    setError(undefined);
    runtime.admin.dispatch({ type: "MUTATING" });
    try {
      const payload = {
        version: 1 as const,
        username: input.user.username,
        expectedRevision: input.user.revision,
      };
      const result =
        method === "admin/user/disable"
          ? await durableMutation({
              owner: runtime.scope,
              gateway: runtime.gateway,
              method,
              payload,
            })
          : method === "admin/user/enable"
            ? await durableMutation({
                owner: runtime.scope,
                gateway: runtime.gateway,
                method,
                payload,
              })
            : await durableMutation({
                owner: runtime.scope,
                gateway: runtime.gateway,
                method,
                payload,
              });
      input.onChanged(result.user);
    } catch (reason) {
      setError(message(reason));
    } finally {
      runtime.admin.dispatch({ type: "LOAD" });
    }
  };

  const scheduleRemoval = async () => {
    setError(undefined);
    runtime.admin.dispatch({ type: "MUTATING" });
    try {
      const result = await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "admin/user/removal/schedule",
        payload: {
          version: 1,
          username: input.user.username,
          expectedRevision: input.user.revision,
          removeAfter: new Date(removeAfter).toISOString(),
        },
      });
      input.onChanged(result.user);
    } catch (reason) {
      setError(message(reason));
    } finally {
      runtime.admin.dispatch({ type: "LOAD" });
    }
  };

  const issueRecovery = async () => {
    setError(undefined);
    runtime.admin.dispatch({ type: "MUTATING" });
    try {
      const result = await runtime.gateway.request(
        "admin/user/recovery/start",
        {
          version: 1,
          username: input.user.username,
          expectedRevision: input.user.revision,
        },
        mutationOptions(),
      );
      input.onHandoff({
        username: result.username,
        code: result.handoffCode,
        expiresAt: result.expiresAt,
      });
    } catch (reason) {
      setError(message(reason));
    } finally {
      runtime.admin.dispatch({ type: "LOAD" });
    }
  };

  return (
    <div className="managed-user">
      <div>
        <strong>{input.user.username}</strong>
        <code>{input.user.home}</code>
        <span>{adminUserStatusLabel(input.user.status)}</span>
      </div>
      <div className="admin-user-actions">
        {input.user.status === "enabled" ? (
          <button
            disabled={admin.status === "mutating"}
            type="button"
            onClick={() => void mutate("admin/user/disable")}
          >
            停用 Web
          </button>
        ) : input.user.status === "disabled" ? (
          <button
            disabled={admin.status === "mutating"}
            type="button"
            onClick={() => void mutate("admin/user/enable")}
          >
            重新启用
          </button>
        ) : null}
        {input.user.status === "removal_pending" ? (
          <button
            disabled={admin.status === "mutating"}
            type="button"
            onClick={() => void mutate("admin/user/removal/cancel")}
          >
            取消移除
          </button>
        ) : input.user.status === "enabled" ||
          input.user.status === "disabled" ? (
          <label>
            移除时间
            <input
              type="datetime-local"
              value={removeAfter}
              onChange={(event) => setRemoveAfter(event.target.value)}
            />
            <button
              disabled={admin.status === "mutating"}
              type="button"
              onClick={() => void scheduleRemoval()}
            >
              计划移除
            </button>
          </label>
        ) : null}
        <button
          disabled={admin.status === "mutating"}
          type="button"
          onClick={() => void issueRecovery()}
        >
          签发恢复交接码
        </button>
      </div>
      {error === undefined ? null : (
        <StatusMessage tone="error">{error}</StatusMessage>
      )}
    </div>
  );
}

function defaultRemovalTime(): string {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function Metric(input: { readonly label: string; readonly value: number }) {
  return (
    <div>
      <strong>{input.value}</strong>
      <span>{input.label}</span>
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "管理操作失败";
}

function adminUserStatusLabel(status: AdminUser["status"]): string {
  const labels: Record<AdminUser["status"], string> = {
    enabled: "已启用",
    disabled: "已停用",
    removal_pending: "等待移除",
    removing: "正在移除",
    removed: "已移除",
  };
  return labels[status];
}
