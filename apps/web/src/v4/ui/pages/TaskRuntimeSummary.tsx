import { Icon } from "../components/Icon.js";
import styles from "./TaskRuntimeSummary.module.css";

export function TaskRuntimeSummary(input: {
  readonly approval: string;
  readonly approvalNeedsAttention: boolean;
  readonly effort: string;
  readonly model: string;
  readonly revision: number;
  readonly sandbox: string;
  readonly sandboxNeedsAttention: boolean;
  readonly status: string;
  readonly statusLabel: string;
  readonly onEdit: () => void;
}) {
  const elevatedAccess =
    input.sandboxNeedsAttention && input.approvalNeedsAttention;

  return (
    <section
      aria-label="任务运行设置摘要"
      className={styles.card}
      data-elevated-access={elevatedAccess || undefined}
      data-task-runtime-summary
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          <strong>本任务配置</strong>
          {elevatedAccess ? (
            <span
              className={styles.risk}
              title="当前任务同时使用完全文件访问和从不询问"
            >
              高权限
            </span>
          ) : null}
          <span className={`${styles.mobileState} state-pill ${input.status}`}>
            <i />
            {input.statusLabel}
          </span>
        </div>
        <button
          aria-label="任务设置"
          className={styles.edit}
          title={`修改任务设置（当前版本 ${input.revision}）`}
          type="button"
          onClick={input.onEdit}
        >
          <Icon name="settings" />
          <span>修改</span>
        </button>
      </header>
      <dl className={styles.values} data-task-context-values>
        <ContextValue label="模型" value={input.model} />
        <ContextValue label="推理" value={input.effort} />
        <ContextValue
          label="文件"
          needsAttention={input.sandboxNeedsAttention}
          value={input.sandbox}
        />
        <ContextValue
          label="审批"
          needsAttention={input.approvalNeedsAttention}
          value={input.approval}
        />
      </dl>
    </section>
  );
}

function ContextValue(input: {
  readonly label: string;
  readonly needsAttention?: boolean;
  readonly value: string;
}) {
  return (
    <div
      aria-label={`${input.label}：${input.value}`}
      className={input.needsAttention ? styles.needsAttention : undefined}
      title={input.value}
    >
      <dt>{input.label}</dt>
      <dd>{input.value}</dd>
    </div>
  );
}
