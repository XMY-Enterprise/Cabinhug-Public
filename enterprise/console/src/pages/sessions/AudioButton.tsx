/**
 * 会话试听按钮。
 *
 * # 两种音频，措辞必须分开
 *
 * 车主那句是端上录入的原始波形（建轮时转存），播放的就是当时的声音。
 * 助手那句服务端没有存档：合成发生在端上（豆包档直连火山），因此第一次点击
 * 会按当时下发的档位重新合成，之后取存下来的那份。
 * 按钮的文案与 title 据此区分，不把补合成的音频标成"当时播的那段"。
 *
 * # 不用 `<audio controls src=…>`
 *
 * 后台接口要带 Authorization 头，`<audio src>` 无法携带。因此先取 Blob
 * 再转 objectURL；组件卸载与重取时都要 revoke，避免音频在内存中累积。
 */

import { useEffect, useRef, useState, type JSX } from "react";

import { api, ApiError } from "../../api";

export type AudioKind = "asr" | "tts";

const ERROR_LABEL: Record<string, string> = {
  audio_not_stored: "这段录音没有存下来（早于试听功能上线）",
  message_not_found: "消息不存在",
  empty_content: "这条没有可合成的文本",
  config_unavailable: "配置层读不到，稍后再试",
  tts_quota_exceeded: "今日合成字符已达上界",
  synthesis_failed: "合成失败",
  audit_unavailable: "审计写入失败，已拒绝放行",
};

export function AudioButton({
  messageId,
  kind,
  stored,
}: {
  messageId: string;
  kind: AudioKind;
  /** 服务端已存有这段音频。未存的助手消息点击后先合成，需多等几秒。 */
  stored: boolean;
}): JSX.Element {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  // 卸载时收干净：停播 + 释放 objectURL。
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const play = async (): Promise<void> => {
    if (state === "playing") {
      audioRef.current?.pause();
      setState("idle");
      return;
    }
    setError(null);
    // 已取过则直接重放，不再请求接口，也不再写审计。
    if (urlRef.current && audioRef.current) {
      void audioRef.current.play();
      setState("playing");
      return;
    }
    setState("loading");
    try {
      const { blob } = await api.blob(`/console/messages/${messageId}/audio`);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const el = new Audio(url);
      el.onended = () => setState("idle");
      el.onerror = () => {
        setError("这段音频浏览器放不出来");
        setState("error");
      };
      audioRef.current = el;
      await el.play();
      setState("playing");
    } catch (e) {
      const code = e instanceof ApiError ? e.code : String(e);
      setError(
        (ERROR_LABEL[code] ?? code) +
          (e instanceof ApiError && e.message && e.message !== code ? `：${e.message}` : ""),
      );
      setState("error");
    }
  };

  const label =
    state === "loading" ? (stored || kind === "asr" ? "载入中…" : "合成中…") : state === "playing" ? "⏸ 停止" : "▶ 试听";
  const title =
    kind === "asr"
      ? "车主当时的原始录音"
      : stored
        ? "已存下的合成音（按当时下发的档位补合成，非端上播出的原始字节）"
        : "服务端没有端上播出的音频，点击按当时下发的档位补合成一次并存下来";

  return (
    <>
      <button
        type="button"
        className="ss-audio-btn"
        onClick={() => void play()}
        disabled={state === "loading"}
        title={title}
      >
        {label}
      </button>
      {error ? <span className="ss-audio-err">{error}</span> : null}
    </>
  );
}
