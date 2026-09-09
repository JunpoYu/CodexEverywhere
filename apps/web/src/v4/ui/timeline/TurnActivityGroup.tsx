import { useState } from "react";

import { Icon } from "../components/Icon.js";
import type { TimelineItem } from "./timeline-item-model.js";
import { TimelineItemView } from "./TimelineItemView.js";
import styles from "./TurnActivityGroup.module.css";

export function TurnActivityGroup(input: {
  readonly className?: string | undefined;
  readonly items: readonly TimelineItem[];
}) {
  const [open, setOpen] = useState(false);
  const hasFailure = input.items.some(activityFailed);
  const itemCount = input.items.length.toLocaleString("zh-CN");
  return (
    <details
      className={`${styles.group}${input.className === undefined ? "" : ` ${input.className}`}`}
      data-failed={hasFailure || undefined}
      data-timeline-activity-group
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title="展开查看推理摘要、命令、文件修改和工具活动">
        <i aria-hidden="true" />
        <strong>{hasFailure ? "处理过程有失败" : "处理过程"}</strong>
        <span>{itemCount} 项</span>
        <Icon name="chevron-down" />
      </summary>
      {open ? (
        <div className={styles.items}>
          {input.items.map((item) => (
            <TimelineItemView item={item} key={item.id} />
          ))}
        </div>
      ) : null}
    </details>
  );
}

function activityFailed(item: TimelineItem): boolean {
  if (item.data.error !== undefined && item.data.error !== null) return true;
  const status =
    typeof item.data.status === "string" ? item.data.status.toLowerCase() : "";
  return (
    status.includes("fail") ||
    status.includes("declin") ||
    status.includes("cancel")
  );
}
