/**
 * ⑤环境缓存的分页浏览。
 *
 * # 这一类单独成块
 *
 * 另外五类的明细都走 `/console/memory/items/:userId`，按用户取，一次二十条即可。
 * ⑤按地点存（键上不含 userId，同一个地方的天气对所有人是同一份），
 * 量级与用户数无关而与去过的地方有关，且需要按命名空间分类查看
 * （`regeo` 是逆地理编码、`amap-forecast` 是天气预报、`route` 是路线）。
 *
 * # 翻页用 offset 而不是游标
 *
 * Redis 的 SCAN 游标是单向的：翻不回上一页，且顺序跨调用不稳定，
 * 按游标分页会出现重复或遗漏条目。
 * 所以服务端是"扫全量键 → 排序 → 切片"，这一层只管 offset。
 *
 * # 三种"没有"分开提示
 *
 * 未接入 Redis（`wired:false`）／这一页是空的／读不到（502）外观都是空列表，
 * 含义不同，需分别说明。
 */

import { useCallback, useEffect, useState } from "react";

import { api } from "../../api";
import { EnvCacheDetailModal } from "./env-cache-detail";
import { NS_LABEL } from "./env-cache-format";

export interface EnvCacheEntry {
  key: string;
  namespace: string;
  ttlSeconds: number;
  sizeBytes: number;
  preview: string;
  /** 服务端算好的人话标题与摘要；老版本运行时没有这两个字段时回落到键名与预览。 */
  title?: string;
  summary?: string;
}

interface Listing {
  wired: boolean;
  entries?: EnvCacheEntry[];
  total?: number;
  totalAll?: number;
  truncated?: boolean;
  namespaces?: Array<{ namespace: string; count: number }>;
}

const PAGE_SIZE = 20;

// 命名空间 → 人话的表在 `env-cache-format.ts`（详情弹窗也用同一份）。

/**
 * 剩余存活时间。
 *
 * `-1` 单独提示：那是没有 TTL 的键，表示有写入绕过了 `withEnvCache` 直接写
 * Redis，这种键永不过期，会一直以陈旧数据应答，不能显示成"很久"。
 */
export function ttlText(sec: number): string {
  if (sec === -1) return "⚠️ 无 TTL（永不过期，不该出现）";
  if (sec === -2) return "已过期";
  if (sec < 60) return `${sec} 秒后过期`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟后过期`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分后过期`;
  // 目的地推荐与导览简报按周缓存，按天显示比"335 小时后过期"易读
  return `${Math.floor(sec / 86_400)} 天 ${Math.floor((sec % 86_400) / 3600)} 小时后过期`;
}

export function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export interface EnvCacheBrowserProps {
  /**
   * 把这次扫出来的库存总数报给卡片。
   *
   * 卡片顶上的大数字来自 runtime 的健康视图，60 秒刷新一次
   * （健康端点被大屏 10 秒轮询一次，每次都 SCAN 会给被观测系统加压）。
   * 展开明细时刚扫过一遍，用新值替换旧值，避免同一张卡上出现两个不一致的总数。
   */
  onTotal?: (total: number) => void;
}

export function EnvCacheBrowser({ onTotal }: EnvCacheBrowserProps = {}): JSX.Element {
  const [page, setPage] = useState(0);
  const [namespace, setNamespace] = useState<string>("");
  const [data, setData] = useState<Listing | "loading" | "error">("loading");
  /** 点开看详情的那一条；null 即关闭。 */
  const [open, setOpen] = useState<EnvCacheEntry | null>(null);

  const load = useCallback(async () => {
    setData("loading");
    const q = new URLSearchParams({ offset: String(page * PAGE_SIZE), limit: String(PAGE_SIZE) });
    if (namespace) q.set("namespace", namespace);
    try {
      const r = await api.get<Listing>(`/console/memory/cache?${q.toString()}`);
      setData(r);
      if (r.wired && r.totalAll !== undefined) onTotal?.(r.totalAll);
    } catch {
      setData("error");
    }
  }, [page, namespace, onTotal]);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === "loading") return <p className="muted tiny">正在读取…</p>;
  if (data === "error") {
    return (
      <p className="error tiny">
        读不到明细（运行时不可达）。<b>这不代表缓存是空的</b>——Redis 的连接握在
        agent-runtime 手上，它不在时我们既数不到也读不到。
      </p>
    );
  }
  if (!data.wired) {
    return (
      <p className="muted tiny">
        ⑤<b>未接入 Redis</b>（`REDIS_URL` 未配或连不上）。外部调用会全部直连上游——
        功能不受影响，只是慢且费配额。这与"缓存里没东西"不是一回事。
      </p>
    );
  }

  const entries = data.entries ?? [];
  const total = data.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="cache-browser">
      {/* 命名空间筛选：同时展示缓存里有哪些类别 */}
      <div className="cache-ns">
        <button
          type="button"
          className={namespace === "" ? "cache-ns-chip is-on" : "cache-ns-chip"}
          onClick={() => {
            setNamespace("");
            setPage(0);
          }}
        >
          全部 {data.totalAll ?? 0}
        </button>
        {(data.namespaces ?? []).map((n) => (
          <button
            key={n.namespace}
            type="button"
            title={NS_LABEL[n.namespace] ?? n.namespace}
            className={namespace === n.namespace ? "cache-ns-chip is-on" : "cache-ns-chip"}
            onClick={() => {
              setNamespace(n.namespace);
              setPage(0);
            }}
          >
            {NS_LABEL[n.namespace] ?? n.namespace} {n.count}
          </button>
        ))}
      </div>

      {/*
        扫描撞上限时必须提示：截断之后的总数不是全部，静默截断会被读成完整结果。
      */}
      {data.truncated ? (
        <p className="error tiny">⚠️ 键太多，扫描已被上限截断——下面的总数是截断后的，不是全部。</p>
      ) : null}

      {entries.length === 0 ? (
        <p className="muted tiny">
          这一{namespace ? "类" : "库"}当前没有条目。⑤是带 TTL 的缓存，
          <b>空是正常状态</b>——过一会儿没人查这些地方，它本来就会空。
        </p>
      ) : (
        <ul className="cache-list">
          {/* 每条都能点开：列表只有 200 字符预览，无法核对内容是否正确 */}
          {entries.map((e) => (
            <li key={e.key}>
              <button
                type="button"
                className="cache-row"
                onClick={() => setOpen(e)}
                aria-label={`查看 ${e.key} 的详情`}
              >
                {/* 人话在前：标题 + 一句摘要；原始键降成小字，供排障使用 */}
                <div className="cache-title">{e.title ?? e.key}</div>
                <div className="cache-summary">{e.summary ?? e.preview}</div>
                <div className="cache-meta">
                  <span className={e.ttlSeconds === -1 ? "cache-ttl-bad" : ""}>{ttlText(e.ttlSeconds)}</span>
                  <span>· {sizeText(e.sizeBytes)}</span>
                  <span className="cache-key mono">· {e.key}</span>
                  <span className="cache-open">查看详情 →</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <EnvCacheDetailModal entry={open} onClose={() => setOpen(null)} />}

      <div className="cache-pager">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
        >
          上一页
        </button>
        <span className="tiny muted">
          第 {page + 1} / {pages} 页 · 共 {total} 条
          {namespace ? `（已筛 ${NS_LABEL[namespace] ?? namespace}）` : ""}
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setPage((p) => p + 1)}
          disabled={page + 1 >= pages}
        >
          下一页
        </button>
        <button type="button" className="mem-items-toggle" onClick={() => void load()}>
          刷新
        </button>
      </div>
      <p className="tiny muted">
        ⑤存的是<b>外部世界的事实</b>（天气/路况/充电价），键上不含 userId ——
        同一个地点的天气对所有人是同一份。它不进 Mem0、不参与衰减，靠 TTL 自己过期。
      </p>
    </div>
  );
}
