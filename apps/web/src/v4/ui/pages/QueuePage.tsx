import { useState, type FormEvent } from "react";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import { useActorState } from "../../actors/use-actor.js";
import { Icon } from "../components/Icon.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { useRuntime } from "../runtime-context.js";

type QueueItem = OutputOf<"queue/list">["items"][number];

export function QueuePage() {
  const runtime = useRuntime();
  const queue = useActorState(runtime.queue);
  return (
    <main
      className="page"
      aria-busy={
        queue.status === "mutating" || queue.status === "indeterminate"
      }
    >
      <header className="page-heading">
        <div>
          <p className="eyebrow">可靠投递</p>
          <h1>Queue</h1>
          <p>待发送请求由宿主机 dispatcher 排队；结果未知不会静默重试。</p>
        </div>
        <button
          disabled={queue.status === "loading"}
          type="button"
          onClick={() => runtime.queue.dispatch({ type: "LOAD" })}
        >
          <Icon name="refresh" />
          刷新
        </button>
      </header>
      {queue.error === undefined ? null : (
        <StatusMessage
          tone={queue.status === "indeterminate" ? "warning" : "error"}
        >
          {queue.error}
        </StatusMessage>
      )}
      <section className="list-panel">
        {queue.items.map((item) => (
          <QueueRow
            busy={
              queue.status === "mutating" || queue.status === "indeterminate"
            }
            item={item}
            key={item.id}
          />
        ))}
        {queue.items.length === 0 ? (
          <div className="empty-state">
            <strong>Queue 为空</strong>
            <span>运行中的任务可从 composer 加入后续请求。</span>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function QueueRow(input: { readonly item: QueueItem; readonly busy: boolean }) {
  const runtime = useRuntime();
  const [editing, setEditing] = useState(false);
  const [replacement, setReplacement] = useState(input.item.text);
  const pending =
    input.item.status === "pending" || input.item.status === "paused";
  const steer = (event: FormEvent) => {
    event.preventDefault();
    const text = replacement.trim();
    if (text.length === 0) return;
    runtime.queue.dispatch({ type: "STEER", itemId: input.item.id, text });
    setEditing(false);
  };
  return (
    <article className="queue-row">
      <div>
        <strong>{input.item.text}</strong>
        <span>任务 {input.item.threadId}</span>
        {input.item.indeterminateReason === undefined ? null : (
          <small>{input.item.indeterminateReason}</small>
        )}
      </div>
      <span className={`state-pill ${input.item.status}`}>
        {queueStatusLabel(input.item.status)}
      </span>
      {pending ? (
        <div className="queue-actions">
          <button
            disabled={input.busy}
            type="button"
            onClick={() => setEditing((value) => !value)}
          >
            调整内容
          </button>
          <button
            disabled={input.busy}
            type="button"
            onClick={() =>
              runtime.queue.dispatch({ type: "REMOVE", itemId: input.item.id })
            }
          >
            移除
          </button>
        </div>
      ) : null}
      {input.item.status === "indeterminate" ? (
        <div className="queue-actions">
          <button
            disabled={input.busy}
            type="button"
            onClick={() =>
              runtime.queue.dispatch({
                type: "ACKNOWLEDGE",
                itemId: input.item.id,
                disposition: "dismiss",
              })
            }
          >
            确认不重试
          </button>
          <button
            className="primary"
            disabled={input.busy}
            type="button"
            onClick={() =>
              runtime.queue.dispatch({
                type: "ACKNOWLEDGE",
                itemId: input.item.id,
                disposition: "retry",
              })
            }
          >
            明确重试
          </button>
        </div>
      ) : null}
      {editing ? (
        <form className="queue-steer-form" onSubmit={steer}>
          <textarea
            aria-label="Steer 替换内容"
            rows={3}
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
          />
          <button className="primary" disabled={input.busy} type="submit">
            发送到当前任务
          </button>
        </form>
      ) : null}
    </article>
  );
}

function queueStatusLabel(status: QueueItem["status"]): string {
  const labels: Record<QueueItem["status"], string> = {
    pending: "等待中",
    paused: "已暂停",
    delivering: "投递中",
    completed: "已完成",
    indeterminate: "结果未知",
  };
  return labels[status];
}
