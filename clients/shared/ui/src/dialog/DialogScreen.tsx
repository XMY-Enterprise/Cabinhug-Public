/**
 * 对话层（F-03-03 / F-03-07 / F-03-09）。
 *
 * 数据由 App 统一管理（桥接订阅单点）：本组件是纯呈现，
 * 消息列表（缓存优先渲染 + 回源校正后替换）+ 流式气泡 + 自动滚动。
 * 车机可读性走 cockpit token。
 *
 * 滚动语义（F-03-07）：贴底时新消息自动跟随；用户上翻后不打扰，
 * 改为浮出"有新消息"提示，点击回到最新。上翻是明确的阅读意图，不应被自动滚动打断。
 *
 * 文字输入（F-03-09）：全产品唯一的输入框在这里，HUD 层没有输入框（US-01 AC-01-1）。
 *
 * 两端共用同一份。唯一的端差异是会话历史栏的排布（`railMode`）：车机横屏放左栏，
 * 手机竖屏折成顶部抽屉。其余部分不分叉，保证两端行为一致（滚动、已中断标记、发送失败告知）。
 */

import { Fragment, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import type { ClientDetections, AttachmentRef, ChatMessage } from "@cabinhug/shared";

import { SessionList, type SessionBrief } from "./SessionList";
import { AttachmentStrip, type AttachmentLoader } from "./AttachmentStrip";
import { CitedSources } from "./CitedSources";
import { checkPendingAdd, detectSummary, durationHint, formatBytes, kindOfMime, onDeviceVisionEnabled, readyDetections, readyHandles, type OnDeviceDetectResult, type PendingAttachment } from "./attachments";

export interface StreamingTurn {
  turnId: string;
  text: string;
}

export interface DialogScreenProps {
  messages: ChatMessage[];
  streaming: StreamingTurn | null;
  connection: "online" | "reconnecting" | "unknown";
  /**
   * 发送文字消息；未提供时不渲染输入框（如浏览器 mock 环境）。
   * `attachments`：本轮要绑的附件句柄（已上传）；没有附件时不传。
   * `detections`（ACR-046）：端上框灯的结果，按句柄索引；没有可带的不传。车机端不选文件，永远拿不到它。
   */
  onSendText?: (content: string, attachments?: string[], detections?: Record<string, ClientDetections>) => Promise<void>;
  /**
   * 附件（F-09-07 / F-09-09）。
   *  - `load`：按引用取原件（Rust 侧带令牌），两端都传，气泡里的缩略图与视频播放靠它；
   *  - `upload`：选择并上传，只有手机端传（车机行车态不选文件，FL-06），不传就没有添加按钮。
   * 整个不传（浏览器 mock 环境）时气泡里只显示「📷 照片」占位，不假装有图。
   */
  attachments?: {
    load: AttachmentLoader;
    upload?: (file: File) => Promise<AttachmentRef>;
    /**
     * 端上框灯（ACR-044）：照片字节进、框出，不出端。开关 `cabinhug.vision.onDevice` 打开时，
     * 选进来的照片顺手跑一遍；只有手机端传（车机行车态不选文件，FL-06，也不设自测入口）。
     */
    detect?: (file: File) => Promise<OnDeviceDetectResult>;
  };
  /**
   * 请拉起一次系统文件选择器（F-20-15「拍照问诊」主页入口）。
   * 单调递增的计数：每次变化触发一次 `fileInputRef.click()`，与点添加按钮是同一个动作。
   * 只在有 `attachments.upload` 时生效（车机不选文件）；不渲染任何节点，不传时标记不变。
   * iOS WebKit 只在用户手势的调用栈里弹选择器：从主页卡点过来要先切页再触发，已出了手势栈，
   * 真机上可能静默不弹；浏览器里能证明 click 发生。
   */
  pickerRequest?: number;
  /**
   * 空态的引导句。缺省是车机那句「回到主页长按助手说话试试」；手机端主页没有长按说话，
   * 传自己的一句，避免给出做不到的指示。
   */
  emptyHint?: string;
  /**
   * 三个可选槽（拍照问诊）：`pinned` 在消息列表上方（钉着的报告条），`trailing` 在列表末尾
   * （观察 / 补拍 / 追问卡，或快捷回复芯片），`inputPlaceholder` 覆盖输入框占位。
   * 都不传时不渲染任何节点、标记不变（车机不传）。槽里放什么由端上决定，本组件不认识报告。
   */
  pinned?: ReactNode;
  trailing?: ReactNode;
  inputPlaceholder?: string;
  /** 播报总开关（F-02-12）；未提供时不渲染 */
  broadcast?: { enabled: boolean; onToggle: () => void | Promise<void> };
  /**
   * 本轮比过车型时给一句去向。
   *
   * 车机不做对比矩阵：`prompts/buying.md` 的硬约束是
   * 「不要摆大表格，车主在车里念不完」。这是驾驶态的取舍，不是功能缺失。
   */
  buyingHint?: boolean;
  /**
   * 工具进展一句话（FL-08 F-08-05），如"正在查天气"。null = 没有进展可说。
   *
   * null 时什么都不显示，不垫一句"正在思考"：那是用户无法证伪的话
   * （与旁路 L0"匹配不到就返回 undefined"同一条规则）。
   */
  progress?: string | null;
  /**
   * 左侧会话历史。不传就不渲染这一栏：浏览器 mock 环境与演示态没有会话列表可拉，
   * 不渲染一个恒空的栏。
   */
  sessions?: {
    items: SessionBrief[];
    hasMore: boolean;
    loading: boolean;
    error?: string | null;
    onSelect: (s: SessionBrief) => void;
    onLoadMore: () => void;
    /** 主动开一段新对话：会话被闲置软关闭后，对话层内要有自己的出口。 */
    onNew?: () => void;
  };
  /**
   * 正在回看一段已结束的历史会话。
   *
   * 回看态下输入框整个不渲染：置灰的输入框仍然在邀请人打字，
   * 而这条会话服务端已经不收消息了。给的是一条出口（回到当前对话），不是一个禁用态。
   */
  viewing?: { sessionId: string; onExit: () => void } | null;
  /** 当前会话 id：列表高亮用。回看态下高亮走 `viewing`。 */
  currentSessionId?: string | null;
  /**
   * 本轮失败/超时分支的人话清单（F-13-03）。
   *
   * 非空时渲染"部分结果"横幅，真相源是 `update.branch` 的结构化 status，
   * 不是应答正文里有没有提到失败。空数组/不传都不渲染。
   * 应答结束后横幅保留到下一轮开始：它标注的是"这轮答案缺了什么"，要跟答案一起读。
   */
  branchFaults?: ReadonlyArray<{ agent: string; text: string }>;
  /**
   * 会话历史栏的排布。`side`（默认）= 左栏，车机横屏；
   * `drawer` = 顶部可折叠抽屉，手机竖屏。只在传了 `sessions` 时有意义。
   */
  railMode?: "side" | "drawer";
}

/*
 * 播报开关的喇叭：与文字同色的线稿，不用 emoji（emoji 由系统字体渲染为彩色）。
 * 规格见 design-system.md §6：图标 24 网格、线宽 2、圆端点，仓库不引图标库，一律内联 SVG。
 */
function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg className="dlg-toggle__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M4 9.5h3.2L12 5.5v13l-4.8-4H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {on ? (
        <>
          <path d="M15.6 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M18.4 6.6a7.8 7.8 0 0 1 0 10.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </>
      ) : (
        <path d="M16 9.5l5 5m0-5l-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}

/**
 * 把答案里的 `**关键信息**` 切成「普通 / 高亮」两种片段。
 *
 * # 只认这一种标记
 *
 * 服务端让模型只用 `**` 标关键信息（规则在 `agent-runtime/src/llm/answer-format.ts`，
 * 叙述者与会答话的 pi 会话共用同一份）。这里不做 markdown 解析，不认标题、
 * 列表、链接、代码块：每多认一种记号，就多一类正文字符被误吞的可能。
 *
 * # 流式时不能闪出星号
 *
 * 一段话是一个 token 一个 token 到的，`**订单号` 会先以「开了但没关」的形态出现。
 * 这里按 `**` 逐个切换状态而不是找配对，于是没闭合的那一半直接当高亮渲染，
 * 星号不会出现在屏幕上；收尾的 `**` 到达后，这段高亮自然收住。
 *
 * 用户自己打的字不走这里（见 `Bubble` 的调用处）：他真打了两个星号，就该原样显示。
 */
export function splitHighlights(text: string): ReadonlyArray<{ text: string; key: boolean }> {
  const out: Array<{ text: string; key: boolean }> = [];
  let at = 0;
  let key = false;
  for (;;) {
    const next = text.indexOf("**", at);
    const chunk = next < 0 ? text.slice(at) : text.slice(at, next);
    if (chunk) out.push({ text: chunk, key });
    if (next < 0) break;
    key = !key;
    at = next + 2;
  }
  return out;
}

/** 助手正文：`**…**` 渲染成高亮片段，其余原样。 */
function RichText({ text }: { text: string }) {
  return (
    <>
      {splitHighlights(text).map((seg, i) =>
        seg.key ? (
          <mark key={i} className="dlg-key">
            {seg.text}
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}

function Bubble({ role, source, attachments, load, children }: {
  role: "user" | "assistant";
  source?: "text" | "voice";
  /** 用户消息随轮带的附件引用；助手消息没有。 */
  attachments?: AttachmentRef[] | null;
  load?: AttachmentLoader;
  children: React.ReactNode;
}) {
  return (
    <div className={`dlg-row dlg-row--${role}`}>
      {/*
        「语音」在气泡外面、贴着气泡上沿，与两端定稿一致
        （`内部文档` 与 `内部文档`）。
        它标注的是消息来源，不是车主说的内容，放进气泡会被读成正文的一部分。
      */}
      {source === "voice" && <span className="dlg-bubble__tag">语音</span>}
      <div className={`dlg-bubble dlg-bubble--${role}`}>
        {attachments && attachments.length > 0 && <AttachmentStrip items={attachments} load={load} />}
        {children}
      </div>
    </div>
  );
}

/** 读视频时长（毫秒），只为提示"超过 1 分钟只看前 60 秒"；读不到不阻止发送。 */
function probeDuration(file: File): Promise<number | undefined> {
  if (typeof document === "undefined" || !file.type.startsWith("video/")) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (ms?: number) => {
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    const timer = setTimeout(() => done(undefined), 4000);
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : undefined);
    };
    v.onerror = () => {
      clearTimeout(timer);
      done(undefined);
    };
    v.src = url;
  });
}

/**
 * 端上框灯的灯箱（ACR-044 验机用）：原图（浏览器按 EXIF 摆正，与框的坐标系一致）+ 一层 SVG 叠框。
 * `viewBox 0 0 1000 1000` + `preserveAspectRatio="none"`：框是 0–1000 归一化的，直接按比例贴上去，不用算像素。
 */
function DetectionLightbox({ item, onClose }: { item: PendingAttachment; onClose: () => void }) {
  const r = item.detect?.result;
  return (
    <div className="dlg-det__lightbox" role="dialog" aria-label="端上框灯结果" onClick={onClose} data-testid="detection-lightbox">
      <div className="dlg-det__frame">
        {item.previewUrl && <img src={item.previewUrl} alt={item.name} />}
        {r && (
          <svg className="dlg-det__overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
            {r.detections.map((d, i) => (
              <rect key={i} x={d.bbox[0]} y={d.bbox[1]} width={Math.max(1, d.bbox[2] - d.bbox[0])} height={Math.max(1, d.bbox[3] - d.bbox[1])} />
            ))}
          </svg>
        )}
      </div>
      <span className="dlg-att__lightbox-hint">{detectSummary(item.detect) ?? item.name} · 点击任意处关闭</span>
    </div>
  );
}

export function DialogScreen({
  messages,
  streaming,
  connection,
  onSendText,
  attachments,
  broadcast,
  buyingHint,
  progress,
  sessions,
  viewing,
  currentSessionId,
  branchFaults,
  railMode = "side",
  pickerRequest,
  emptyHint = "还没有对话。回到主页长按助手说话试试。",
  pinned,
  trailing,
  inputPlaceholder,
}: DialogScreenProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [hasNew, setHasNew] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** 选好 / 在传 / 传好的附件。发送成功后清空并释放预览 URL。 */
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /* 主页「拍照问诊」卡的入口：计数一变就点一次隐藏的 input，没有 upload 端口时什么都不做。 */
  useEffect(() => {
    if (!pickerRequest || !attachments?.upload) return;
    fileInputRef.current?.click();
    // 只认计数变化；upload 端口是稳定引用，不进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerRequest]);
  const uploadRef = useRef(attachments?.upload);
  uploadRef.current = attachments?.upload;
  const detectRef = useRef(attachments?.detect);
  detectRef.current = attachments?.detect;
  /** 正在看框的那一项（灯箱）。 */
  const [boxView, setBoxView] = useState<PendingAttachment | null>(null);

  const patchPending = (id: string, patch: Partial<PendingAttachment>) =>
    setPending((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  /** 起一次上传；失败留在列表里给「重试」，不静默丢（F-09-05）。 */
  const startUpload = (item: PendingAttachment, file: File) => {
    const upload = uploadRef.current;
    if (!upload) return;
    patchPending(item.id, { status: "uploading", error: undefined });
    upload(file)
      .then((ref) => patchPending(item.id, { status: "ready", ref }))
      .catch((err) => patchPending(item.id, { status: "failed", error: err instanceof Error ? err.message : String(err) }));
  };
  const fileOf = useRef(new Map<string, File>());

  /** 端上跑一遍检测（ACR-044）：失败只记在这一项上，不影响上传与发送。 */
  const startDetect = (item: PendingAttachment, file: File) => {
    const detect = detectRef.current;
    if (!detect) return;
    patchPending(item.id, { detect: { status: "running" } });
    detect(file)
      .then((result) => patchPending(item.id, { detect: { status: "done", result } }))
      .catch((err) => patchPending(item.id, { detect: { status: "failed", error: err instanceof Error ? err.message : String(err) } }));
  };


  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    setPickError(null);
    let current = pending;
    for (const file of files) {
      const problem = checkPendingAdd(current, file);
      if (problem) {
        setPickError(problem);
        continue;
      }
      const kind = kindOfMime(file.type);
      if (!kind) continue;
      const item: PendingAttachment = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        name: file.name,
        bytes: file.size,
        contentType: file.type,
        status: "uploading",
        previewUrl: typeof URL !== "undefined" && kind === "image" ? URL.createObjectURL(file) : undefined,
      };
      fileOf.current.set(item.id, file);
      current = [...current, item];
      setPending(current);
      startUpload(item, file);
      /*
       * 端上框灯（ACR-044）：现读开关，不缓存。开关在设置页，缓存成 state 的话，
       * 用户刚在设置页打开、回到对话页选的第一张照片仍然不跑。
       */
      if (kind === "image" && onDeviceVisionEnabled()) startDetect(item, file);
      if (kind === "video") void probeDuration(file).then((ms) => patchPending(item.id, { durationMs: ms }));
    }
  };

  const removePending = (id: string) => {
    setPending((prev) => {
      const it = prev.find((p) => p.id === id);
      if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
    fileOf.current.delete(id);
  };

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
    setHasNew(false);
  };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stickToBottom.current) setHasNew(false);
  };

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    } else if (messages.length > 0) {
      // 上翻期间来了新消息：提示而不是抢滚动
      setHasNew(true);
    }
  }, [messages, streaming?.text]);

  const handles = readyHandles(pending);
  // 有附件时允许不打字（车主常常只发一张照片）；没附件时仍要有字。所有附件传好才能发。
  const canSend = !sending && handles !== null && (draft.trim() !== "" || handles.length > 0);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const content = draft.trim();
    if (!onSendText || !canSend) return;
    setSending(true);
    setSendError(null);
    try {
      const hasHandles = Boolean(handles && handles.length);
      const detections = hasHandles ? readyDetections(pending) : undefined;
      await onSendText(content, hasHandles ? handles! : undefined, ...(detections ? [detections] : []));
      setDraft("");
      for (const p of pending) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      fileOf.current.clear();
      setPending([]);
      scrollToBottom();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  // 高亮的是"屏幕上此刻摊着的那条"：回看时是被回看的那条，否则是当前会话。
  const activeSessionId = viewing?.sessionId ?? currentSessionId ?? null;

  const rail = sessions ? (
    <SessionList
      sessions={sessions.items}
      activeSessionId={activeSessionId}
      hasMore={sessions.hasMore}
      loading={sessions.loading}
      error={sessions.error}
      onSelect={sessions.onSelect}
      onLoadMore={sessions.onLoadMore}
      onNew={sessions.onNew}
    />
  ) : null;
  const drawer = rail !== null && railMode === "drawer";

  return (
    <div className={`dlg-screen ${sessions ? "has-rail" : ""} ${drawer ? "dlg-screen--drawer" : ""}`}>
      {drawer ? (
        /*
         * 抽屉默认收起：手机上进对话层是为了看当前这段，列表是"要换一段"时才打开的。
         * 用原生 <details>（与采集进度折叠节相同），不引状态、不引依赖。
         */
        <details className="dlg-rail dlg-rail--drawer">
          <summary className="dlg-rail__summary">
            会话历史{sessions && sessions.items.length > 0 ? ` · ${sessions.items.length}` : ""}
          </summary>
          {rail}
        </details>
      ) : (
        rail
      )}
      <div className="dlg-main">
      {connection === "reconnecting" && (
        <div className="dlg-banner">连接中断，正在恢复…</div>
      )}
      {/*
        购车对比只在手机端有页面。车机不做对比矩阵：`prompts/buying.md` 的硬约束是
        「不要摆大表格——车主在车里，念不完」。这里只给一句去向，是驾驶态的取舍。
      */}
      {buyingHint && <div className="dlg-banner dlg-banner--info">详细的车型对比已同步到手机端</div>}
      {/*
        部分结果标识（F-13-03）：结构化事件驱动，不依赖应答正文提没提。
        逐条列服务端给的人话（"酒店安排超时未返回"），不加工不合并：
        概括（"部分信息缺失"）回答不了"缺的是哪块"。
      */}
      {branchFaults && branchFaults.length > 0 && (
        <div className="dlg-banner" role="status" data-testid="branch-faults">
          部分结果：{branchFaults.map((f) => f.text).join("；")}
        </div>
      )}
      {broadcast && (
        <div className="dlg-toolbar">
          <button
            type="button"
            className={`dlg-toggle ${broadcast.enabled ? "is-on" : ""}`}
            onClick={() => void broadcast.onToggle()}
            aria-pressed={broadcast.enabled}
          >
            <SpeakerIcon on={broadcast.enabled} />
            {broadcast.enabled ? "播报开启" : "播报关闭"}
          </button>
        </div>
      )}
      {pinned}
      <div className="dlg-list" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && !streaming && (
          <div className="dlg-empty">{emptyHint}</div>
        )}
        {messages.map((m) => (
          <Bubble key={m.messageId} role={m.role} source={m.source} attachments={m.role === "user" ? m.attachments : null} load={attachments?.load}>
            {/* 高亮只给助手：车主自己打的两个星号该原样显示，不该被当成排版记号吃掉。 */}
            {m.role === "assistant" ? <RichText text={m.content} /> : m.content}
            {/*
              被打断的那半句（`cancelled` 字段）。气泡不删：车主已经听见这半句，
              删掉会让刷新前后不一致；标上「已中断」以免读成助手无故说了一半。
              纯离线（端上 SQLite 缓存）读不到这个字段，那时它显示为普通消息（已知限制）。
            */}
            {m.cancelled ? <span className="dlg-cancelled">（已中断）</span> : null}
            {/* 数据来源署名：正文结束后单独一行，不进口播（TTS 只读 content）。 */}
            {m.role === "assistant" ? <CitedSources sources={m.sources} /> : null}
          </Bubble>
        ))}
        {streaming && streaming.text.length > 0 && (
          <Bubble role="assistant">
            <RichText text={streaming.text} />
            <span className="dlg-cursor" aria-hidden="true" />
          </Bubble>
        )}
        {/*
          工具进展（F-08-05）。排在流式气泡之后：它讲的是"接下来还在做什么"，
          放在已出的文字前面会读成"这句话之前发生的事"。

          不是气泡：它不是助手说的话，也不进历史。样式刻意弱于正文，
          避免短时间内连续更新的进度盖过真正的回答。
        */}
        {progress && (
          <div className="dlg-progress" role="status" aria-live="polite">
            <span className="dlg-progress__dot" aria-hidden="true" />
            {progress}
          </div>
        )}
        {trailing}
      </div>

      {hasNew && (
        <button type="button" className="dlg-newmsg" onClick={scrollToBottom}>
          有新消息 ↓
        </button>
      )}

      {/*
        历史回看。不渲染置灰的输入框：置灰的输入框仍在邀请人打字，
        而这条会话服务端已经不收消息了。这里给的是一条出口，不是一个禁用态。
      */}
      {viewing && (
        <div className="dlg-input dlg-input--viewing">
          <span className="dlg-viewing__note">这段对话已结束，只能回看</span>
          <button type="button" onClick={viewing.onExit}>回到当前对话</button>
        </div>
      )}
      {!viewing && onSendText && pending.length > 0 && (
        /*
         * 待发附件条。每项自己的状态：传着 / 传好 / 失败（带重试）。
         * 视频超过 1 分钟只提示不拦：服务端只看前 60 秒并会如实说明。
         */
        <div className="dlg-pending" data-testid="pending-attachments">
          {pending.map((p) => (
            <div key={p.id} className={`dlg-pending__item dlg-pending__item--${p.status}`}>
              {p.previewUrl ? (
                p.detect?.result ? (
                  <button type="button" className="dlg-pending__thumb" onClick={() => setBoxView(p)} aria-label={`查看${p.name}的端上框`}>
                    <img src={p.previewUrl} alt={p.name} />
                  </button>
                ) : (
                  <img src={p.previewUrl} alt={p.name} />
                )
              ) : (
                <span className="dlg-pending__icon" aria-hidden="true">{p.kind === "video" ? "🎬" : "📷"}</span>
              )}
              <span className="dlg-pending__meta">
                <span className="dlg-pending__name">{p.name}</span>
                <span className="dlg-pending__state">
                  {p.status === "uploading" ? "上传中…" : p.status === "ready" ? formatBytes(p.bytes) : `失败：${p.error ?? "未知错误"}`}
                </span>
                {/*
                  端上框灯的那行「seatbelt_unfastened 72%、…」不在待发条上显示：
                  它是原始类别名与置信度，车主读不懂，且会把卡片撑高一倍。
                  检测照跑、框照样随轮发出；点缩略图可在灯箱（`DetectionLightbox`）里看到这一行。
                */}
                {p.kind === "video" && durationHint(p.durationMs) && <span className="dlg-pending__hint">{durationHint(p.durationMs)}</span>}
              </span>
              {p.status === "failed" && (
                <button type="button" onClick={() => { const f = fileOf.current.get(p.id); if (f) startUpload(p, f); }}>重试</button>
              )}
              <button type="button" className="dlg-pending__remove" onClick={() => removePending(p.id)} aria-label={`移除${p.name}`}>×</button>
            </div>
          ))}
        </div>
      )}
      {boxView && <DetectionLightbox item={boxView} onClose={() => setBoxView(null)} />}
      {!viewing && onSendText && (
        <form className="dlg-input" onSubmit={submit}>
          {attachments?.upload && (
            <>
              {/*
                系统文件选择器：iOS 的 WKWebView 对 accept=image/*,video/* 会弹「拍照 / 相册 / 文件」，
                不需要相机插件；选出的视频由系统按导出质量转码，60 秒通常 15–40 MB。
              */}
              <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple hidden onChange={onPickFiles} data-testid="attachment-picker" />
              <button type="button" className="dlg-attach" onClick={() => fileInputRef.current?.click()} disabled={sending} aria-label="添加照片或视频" title="添加照片或视频">
                {/* 相机线稿，不用 emoji：emoji 字形随系统变化，与定稿及拍照页的相机图标不一致。 */}
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h2l1.2-2h4.6l1.2 2h2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" />
                  <circle cx="12" cy="12.5" r="3.5" />
                </svg>
              </button>
            </>
          )}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={pending.length ? "说说想问什么（可不填）" : (inputPlaceholder ?? "打字输入…（驾驶中请用语音）")}
            disabled={sending}
            aria-label="文字输入"
          />
          <button type="submit" disabled={!canSend}>
            {sending ? "发送中" : "发送"}
          </button>
        </form>
      )}
      {pickError && <div className="dlg-banner dlg-banner--error">{pickError}</div>}
      {sendError && <div className="dlg-banner dlg-banner--error">发送失败：{sendError}</div>}
      </div>
    </div>
  );
}
