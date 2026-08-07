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
  readonly #toggleHome: HTMLElement;
  readonly #toggleAnchor: ChildNode | null;
  readonly #observer: MutationObserver;
  readonly #compactLayout = window.matchMedia("(max-width: 1180px)");
  #entries: OutlineEntry[] = [];
  #signature = "";
  #active = false;
  #desktopCollapsed = false;
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
    this.#toggleHome = toggle.parentElement ?? content;
    this.#toggleAnchor = toggle.nextSibling;
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
    this.#compactLayout.addEventListener("change", () => {
      this.#panel.classList.remove("open");
      this.#renderVisibility();
    });
  }

  setThreadActive(active: boolean): void {
    this.#active = active;
    this.#panel.classList.remove("open");
    this.#renderVisibility();
    this.#signature = "";
    this.#entries = [];
    this.#list.replaceChildren();
    this.#count.textContent = "0 条";
    this.#panel.classList.toggle("empty", active);
    if (active) this.sync();
  }

  toggle(): void {
    if (!this.#active) return;
    if (this.#compactLayout.matches) {
      this.#panel.classList.toggle("open");
    } else {
      this.#desktopCollapsed = !this.#desktopCollapsed;
    }
    this.#renderVisibility();
  }

  collapse(): void {
    if (!this.#active) return;
    if (this.#compactLayout.matches) this.#panel.classList.remove("open");
    else this.#desktopCollapsed = true;
    this.#renderVisibility();
  }

  dismissOverlay(): void {
    if (!this.#compactLayout.matches) return;
    this.#panel.classList.remove("open");
    this.#renderVisibility();
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
        key: card.dataset.itemId ?? card.dataset.localUser ?? text,
      };
    });
    const signature = items
      .map((item) => `${item.key}\u0000${item.label}`)
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
    if (this.#compactLayout.matches) this.collapse();
  }

  #renderVisibility(): void {
    const compact = this.#compactLayout.matches;
    this.#placeToggle(compact);
    if (!this.#active || !compact) this.#panel.classList.remove("open");
    const panelExpanded = compact
      ? this.#panel.classList.contains("open")
      : !this.#desktopCollapsed;
    const expanded = this.#active && panelExpanded;
    this.#content.classList.toggle(
      "outline-available",
      this.#active && (compact || panelExpanded),
    );
    this.#panel.hidden = !this.#active || (!compact && !panelExpanded);
    this.#toggle.hidden = !this.#active;
    this.#toggle.setAttribute("aria-expanded", String(expanded));
    this.#toggle.setAttribute(
      "aria-label",
      expanded ? "收起对话大纲" : "展开对话大纲",
    );
    this.#toggle.title = expanded ? "收起对话大纲" : "展开对话大纲";
  }

  #placeToggle(compact: boolean): void {
    if (compact) {
      if (this.#toggle.parentElement !== this.#toggleHome) {
        const anchor =
          this.#toggleAnchor?.parentNode === this.#toggleHome
            ? this.#toggleAnchor
            : null;
        this.#toggleHome.insertBefore(this.#toggle, anchor);
      }
      return;
    }
    if (this.#toggle.parentElement !== this.#content) {
      this.#content.append(this.#toggle);
    }
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
