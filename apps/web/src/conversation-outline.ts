const DEFAULT_OUTLINE_LABEL_LENGTH = 54;

export function conversationOutlineLabel(
  text: string,
  maxLength = DEFAULT_OUTLINE_LABEL_LENGTH,
): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return "（空消息）";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

type OutlineEntry = {
  card: HTMLElement;
  button: HTMLButtonElement;
};

export class ConversationOutlineView {
  readonly #timeline: HTMLElement;
  readonly #content: HTMLElement;
  readonly #panel: HTMLElement;
  readonly #list: HTMLElement;
  readonly #count: HTMLElement;
  readonly #toggle: HTMLButtonElement;
  readonly #observer: MutationObserver;
  #entries: OutlineEntry[] = [];
  #signature = "";
  #active = false;
  #syncPending = false;
  #scrollFrame: number | undefined;
  #highlightTimer: number | undefined;
  #activeLockUntil = 0;

  constructor(
    timeline: HTMLElement,
    content: HTMLElement,
    panel: HTMLElement,
    list: HTMLElement,
    count: HTMLElement,
    toggle: HTMLButtonElement,
  ) {
    this.#timeline = timeline;
    this.#content = content;
    this.#panel = panel;
    this.#list = list;
    this.#count = count;
    this.#toggle = toggle;
    this.#observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesUserMessage)) this.#scheduleSync();
    });
    this.#observer.observe(timeline, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    timeline.addEventListener("scroll", () => this.#scheduleActiveUpdate(), {
      passive: true,
    });
  }

  setThreadActive(active: boolean): void {
    this.#active = active;
    this.#content.classList.toggle("outline-available", active);
    this.#panel.hidden = !active;
    this.#toggle.hidden = !active;
    this.closeDrawer();
    this.#signature = "";
    this.#entries = [];
    this.#list.replaceChildren();
    this.#count.textContent = "0 条";
    this.#panel.classList.toggle("empty", active);
    if (active) this.sync();
  }

  toggleDrawer(): void {
    if (!this.#active) return;
    const open = !this.#panel.classList.contains("open");
    this.#panel.classList.toggle("open", open);
    this.#toggle.setAttribute("aria-expanded", String(open));
  }

  closeDrawer(): void {
    this.#panel.classList.remove("open");
    this.#toggle.setAttribute("aria-expanded", "false");
  }

  sync(): void {
    if (!this.#active) return;
    const cards = Array.from(
      this.#timeline.querySelectorAll<HTMLElement>(".timeline-entry.user"),
    );
    const items = cards.map((card) => {
      const text =
        card.querySelector<HTMLElement>(".message-text")?.textContent ?? "";
      return {
        card,
        label: conversationOutlineLabel(text),
        queued: card.classList.contains("queued-message"),
        key:
          card.dataset.itemId ??
          card.dataset.queueId ??
          card.dataset.localUser ??
          text,
      };
    });
    const signature = items
      .map((item) => `${item.key}\u0000${item.label}\u0000${item.queued}`)
      .join("\u0001");
    if (signature === this.#signature) {
      this.#scheduleActiveUpdate();
      return;
    }
    this.#signature = signature;
    this.#list.replaceChildren();
    this.#entries = items.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "conversation-outline-item";
      button.title = item.label;
      button.setAttribute(
        "aria-label",
        `跳转到第 ${String(index + 1)} 条你的消息：${item.label}`,
      );

      const number = document.createElement("span");
      number.className = "conversation-outline-number";
      number.textContent = String(index + 1).padStart(2, "0");
      const label = document.createElement("span");
      label.className = "conversation-outline-label";
      label.textContent = item.label;
      button.append(number, label);
      if (item.queued) {
        const status = document.createElement("small");
        status.textContent = "排队";
        button.append(status);
      }
      button.addEventListener("click", () => this.#jumpTo(item.card, button));
      this.#list.append(button);
      return { card: item.card, button };
    });
    this.#count.textContent = `${String(items.length)} 条`;
    this.#panel.classList.toggle("empty", items.length === 0);
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "conversation-outline-empty";
      empty.textContent = "发送消息后，大纲会在这里生成。";
      this.#list.append(empty);
    }
    this.#scheduleActiveUpdate();
  }

  #scheduleSync(): void {
    if (this.#syncPending) return;
    this.#syncPending = true;
    queueMicrotask(() => {
      this.#syncPending = false;
      this.sync();
    });
  }

  #scheduleActiveUpdate(): void {
    if (this.#scrollFrame !== undefined) return;
    this.#scrollFrame = window.requestAnimationFrame(() => {
      this.#scrollFrame = undefined;
      this.#updateActiveItem();
    });
  }

  #updateActiveItem(): void {
    if (this.#entries.length === 0) return;
    if (Date.now() < this.#activeLockUntil) return;
    const timelineTop = this.#timeline.getBoundingClientRect().top;
    const marker =
      timelineTop + Math.min(this.#timeline.clientHeight * 0.28, 190);
    let activeIndex = 0;
    for (const [index, entry] of this.#entries.entries()) {
      if (entry.card.getBoundingClientRect().top <= marker) activeIndex = index;
      else break;
    }
    for (const [index, entry] of this.#entries.entries()) {
      const current = index === activeIndex;
      entry.button.classList.toggle("active", current);
      if (current) entry.button.setAttribute("aria-current", "location");
      else entry.button.removeAttribute("aria-current");
    }
  }

  #jumpTo(card: HTMLElement, button: HTMLButtonElement): void {
    this.#activeLockUntil = Date.now() + 900;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    for (const entry of this.#entries) {
      const current = entry.button === button;
      entry.button.classList.toggle("active", current);
      if (current) entry.button.setAttribute("aria-current", "location");
      else entry.button.removeAttribute("aria-current");
    }
    card.classList.remove("conversation-jump-target");
    void card.offsetWidth;
    card.classList.add("conversation-jump-target");
    if (this.#highlightTimer !== undefined)
      window.clearTimeout(this.#highlightTimer);
    this.#highlightTimer = window.setTimeout(() => {
      card.classList.remove("conversation-jump-target");
      this.#highlightTimer = undefined;
    }, 1_500);
    if (window.matchMedia("(max-width: 1180px)").matches) this.closeDrawer();
  }
}

function mutationTouchesUserMessage(mutation: MutationRecord): boolean {
  if (mutation.type === "characterData")
    return nodeIsInsideUserMessage(mutation.target);
  if (nodeIsInsideUserMessage(mutation.target)) return true;
  return [...mutation.addedNodes, ...mutation.removedNodes].some(
    nodeTouchesUserMessage,
  );
}

function nodeIsInsideUserMessage(node: Node): boolean {
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return Boolean(
    element?.matches(".timeline-entry.user") ||
    element?.closest(".timeline-entry.user"),
  );
}

function nodeTouchesUserMessage(node: Node): boolean {
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return Boolean(
    element?.matches(".timeline-entry.user") ||
    element?.closest(".timeline-entry.user") ||
    element?.querySelector(".timeline-entry.user"),
  );
}
