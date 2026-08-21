import { useState } from "react";

import { Icon } from "../components/Icon.js";
import { ModalDialog } from "../components/ModalDialog.js";
import type { ConversationOutlineEntry } from "./conversation-outline-model.js";
import styles from "./ConversationOutlineDialog.module.css";

export function ConversationOutlineDialog(input: {
  readonly activeItemId?: string | undefined;
  readonly entries: readonly ConversationOutlineEntry[];
  readonly hasEarlierHistory: boolean;
  readonly historyDisabled?: boolean | undefined;
  readonly historyStatus: "idle" | "loading" | "failed";
  readonly onClose: () => void;
  readonly onLoadEarlier: () => void;
  readonly onSelect: (itemId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const numberedEntries = input.entries.map((entry, index) => ({
    entry,
    number: index + 1,
  }));
  const visibleEntries =
    normalizedQuery.length === 0
      ? numberedEntries
      : numberedEntries.filter(({ entry }) =>
          entry.label.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
        );

  return (
    <ModalDialog
      aria-describedby="conversation-outline-description"
      aria-labelledby="conversation-outline-title"
      className={`ce-dialog ${styles.dialog}`}
      id="conversation-outline"
      onRequestClose={input.onClose}
    >
      <header className={styles.header}>
        <div>
          <span>当前已加载 {input.entries.length} 条请求</span>
          <h2 id="conversation-outline-title">对话大纲</h2>
          <p id="conversation-outline-description">
            按你发送的消息快速定位，不会自动加载完整历史。
          </p>
        </div>
        <button
          aria-label="关闭对话大纲"
          className={styles.close}
          type="button"
          onClick={input.onClose}
        >
          <Icon name="close" />
        </button>
      </header>

      {input.entries.length >= 8 ? (
        <label className={styles.search}>
          <span>筛选已加载请求</span>
          <input
            placeholder="输入关键词"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}

      <nav aria-label="已加载的用户消息" className={styles.list}>
        {input.hasEarlierHistory ? (
          <button
            className={styles.loadEarlier}
            disabled={
              input.historyDisabled === true ||
              input.historyStatus === "loading"
            }
            type="button"
            onClick={input.onLoadEarlier}
          >
            {input.historyStatus === "loading"
              ? "正在加载更早大纲…"
              : input.historyStatus === "failed"
                ? "重试加载更早大纲"
                : "加载更早大纲"}
          </button>
        ) : null}
        {visibleEntries.map(({ entry, number }) => {
          const active = input.activeItemId === entry.id;
          return (
            <button
              aria-current={active ? "location" : undefined}
              className={`${styles.entry}${active ? ` ${styles.active}` : ""}`}
              key={entry.id}
              title={entry.label}
              type="button"
              onClick={() => input.onSelect(entry.id)}
            >
              <span>{String(number).padStart(2, "0")}</span>
              <strong>{entry.label}</strong>
              {entry.createdAt === undefined ? null : (
                <time dateTime={entry.createdAt}>
                  {new Date(entry.createdAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              )}
            </button>
          );
        })}
        {visibleEntries.length === 0 ? (
          <p className={styles.empty}>
            {input.entries.length === 0
              ? "发送消息后，大纲会在这里生成。"
              : "已加载请求中没有匹配项。"}
          </p>
        ) : null}
      </nav>
    </ModalDialog>
  );
}
