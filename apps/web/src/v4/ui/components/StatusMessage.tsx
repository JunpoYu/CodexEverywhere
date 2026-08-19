import type { ReactNode } from "react";

import { Icon } from "./Icon.js";
import styles from "./StatusMessage.module.css";

export function StatusMessage(input: {
  readonly children: ReactNode;
  readonly tone: "success" | "error" | "warning" | "info";
}) {
  const urgent = input.tone === "error" || input.tone === "warning";
  const icon =
    input.tone === "success"
      ? "check"
      : input.tone === "info"
        ? "connection"
        : "danger";
  return (
    <p
      className={`${styles.message} ${styles[input.tone]}`}
      role={urgent ? "alert" : "status"}
    >
      <Icon name={icon} />
      <span>{input.children}</span>
    </p>
  );
}
