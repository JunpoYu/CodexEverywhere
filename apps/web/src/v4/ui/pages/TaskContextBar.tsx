import { Icon } from "../components/Icon.js";
import styles from "./TaskContextBar.module.css";

export function TaskContextBar(input: {
  readonly approval: string;
  readonly effort: string;
  readonly model: string;
  readonly revision: number;
  readonly sandbox: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly onEdit: () => void;
}) {
  return (
    <section className={styles.bar} aria-label="任务运行设置摘要">
      <span className={`${styles.mobileState} state-pill ${input.status}`}>
        <i />
        {input.statusLabel}
      </span>
      <dl className={styles.values} data-task-context-values>
        <ContextValue label="模型" value={input.model} />
        <ContextValue label="推理" value={input.effort} />
        <ContextValue label="文件" value={input.sandbox} />
        <ContextValue label="审批" value={input.approval} />
      </dl>
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
    </section>
  );
}

function ContextValue(input: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div aria-label={`${input.label}：${input.value}`} title={input.value}>
      <dt>{input.label}</dt>
      <dd>{input.value}</dd>
    </div>
  );
}
