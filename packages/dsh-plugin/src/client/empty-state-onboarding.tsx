import { useState } from "react";

/** One creation entry on the empty-state onboarding panel. */
export interface OnboardingEntry {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  /** Message sent to the current session's AI when the entry is clicked. */
  readonly prompt: string;
}

export const ONBOARDING_ENTRIES: readonly OnboardingEntry[] = [
  {
    key: "novel-long",
    label: "新建长篇",
    hint: "story-setup",
    prompt: "请用 story-setup 初始化一个长篇小说工程（建立 正文/、设定/、大纲/、追踪/，书名请先向我确认）。"
  },
  {
    key: "novel-short",
    label: "新建短篇",
    hint: "story-setup",
    prompt: "请用 story-setup 初始化一个短篇小说工程（保持轻量结构，不强加长篇追踪，题材请先向我确认）。"
  },
  {
    key: "drama",
    label: "新建短剧",
    hint: "short-drama",
    prompt: "请用 short-drama 按 v0.6 creator-first 契约初始化一个短剧项目（只建本次需要的文档，题材与集数请先向我确认）。"
  },
  {
    key: "game",
    label: "新建游戏",
    hint: "novel-to-game",
    prompt: "请用 novel-to-game 为我新建一个游戏改编项目（先确认题材与来源，再起草 PRODUCT_BRIEF.md，书名或原著请先向我确认）。"
  },
  {
    key: "video",
    label: "新建视频",
    hint: "video-recap",
    prompt: "请用 video-recap 为我新建一个视频解说项目（放在 video-recaps/<项目>/，我随后提供源视频，选题请先向我确认）。"
  }
];

async function copyText(text: string): Promise<boolean> {
  try {
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (permissions, insecure context): fall back to execCommand.
    try {
      const document = globalThis.document;
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Empty-state onboarding: shown when the workspace holds no creative project.
 * Clicking an entry sends its prompt to the current session's AI; when sending
 * fails the prompt is copied to the clipboard instead so the creator can paste
 * it manually. Styling follows plugin.css DSW tokens via class names only.
 */
export function EmptyStateOnboarding({ onCreate }: {
  readonly onCreate: (prompt: string) => Promise<void>;
}): React.JSX.Element {
  const [pendingKey, setPendingKey] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const create = (entry: OnboardingEntry): void => {
    setPendingKey(entry.key);
    setNotice(undefined);
    void onCreate(entry.prompt).then(
      () => {
        setPendingKey(undefined);
        setNotice("已发送给 AI，建项开始后工作台会自动出现。");
      },
      () => {
        void copyText(entry.prompt).then((copied) => {
          setPendingKey(undefined);
          setNotice(copied
            ? "发送失败，已复制建项口令，粘贴发送给 AI 即可创建。"
            : "发送失败，请手动复制这段口令发送给 AI：" + entry.prompt);
        });
      }
    );
  };
  return <section className="oh-story-empty" aria-label="创作工程引导">
    <h2 className="oh-story-empty-title">尚未检测到创作工程</h2>
    <p className="oh-story-empty-desc">选一条产物线开始，点击后会把建项请求发送给当前会话的 AI。</p>
    <div className="oh-story-empty-grid">
      {ONBOARDING_ENTRIES.map((entry) => <button
        key={entry.key}
        className="oh-story-empty-entry"
        type="button"
        title={entry.hint}
        aria-label={`${entry.label}（${entry.hint}）`}
        disabled={pendingKey !== undefined}
        onClick={() => { create(entry); }}
      ><b>{pendingKey === entry.key ? "发送中…" : entry.label}</b><span>{entry.hint}</span></button>)}
    </div>
    {notice !== undefined && <p className="oh-story-empty-notice" role="status">{notice}</p>}
  </section>;
}
