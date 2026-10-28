/**
 * 主链路图 + 一次运行的投影（会话页逐轮、演示大屏实时，两处共用）。
 *
 * # 复用同一张图而不是画简版
 *
 * 简版意味着第二份节点表，它会漂移，漂移后小图上缺的步骤会被误认为不存在。
 * 这里直接用 `WORKFLOW_NODES/EDGES`，压暗没走到的部分：
 * 读者看到的始终是同一张图上的位置，不是一条被抽出来的路径。
 *
 * # 三种颜色分别回答一个问题
 *
 * 绿 = 走完了；红 = 失败（回放页同一取向：失败靠颜色不靠筛掉别的）；
 * 黄 = 此刻停在这里。不设第四种颜色。
 */

import { memo, useEffect, useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  getRectOfNodes,
  useReactFlow,
  useStore,
} from "reactflow";

import { WORKFLOW_EDGES, WORKFLOW_NODES } from "./graph-model";
import { POS, toEdges, toNodes } from "./layout";
import { ParticleEdge, ReadableSmoothStepEdge } from "./ParticleEdge";
import { edgeWalked, type GraphRun } from "./projection";

const DONE = "#3fb950";
const FAILED = "#f85149";
const ACTIVE = "#d29922";

// 组件外定义：每次渲染新建这个对象的话，reactflow 会当成换了套边类型整图重挂。
const EDGE_TYPES = { smoothstep: ReadableSmoothStepEdge, particle: ParticleEdge };

/**
 * 重建整张图的判据是内容变了，不是 `run` 换了个对象。
 *
 * 实时视图每 250ms 并一批事件就产生一个新的 `run`，而一批里很可能什么都没变
 * （几条 prompt、几条只影响耗时的 span）。按对象身份重算的话，
 * 23 个节点 + 30 条边的样式对象每次全新建一遍，ReactFlow 跟着整片重渲染。
 */
function signature(run: GraphRun): string {
  const nodes = [...run.nodes.entries()]
    .map(([id, r]) => `${id}:${r.state}:${r.durationMs ?? ""}:${r.note ?? ""}`)
    .sort()
    .join("|");
  // finished 也进签名：粒子只在"进行中"的走过边上流动，收口那一刻要停下来。
  return `${nodes}#${[...run.edges].sort().join(",")}#${run.current ?? ""}#${run.finished}#${run.unknownNodes.join(",")}`;
}

/** 定倍取景时，图的左上角距画布左上角留的余量（世界坐标，随缩放一起缩）。 */
const ANCHOR_PAD = 24;

/**
 * 画布尺寸变了就重新取景。
 *
 * `fitView` 只在挂载那一次生效。进投屏时容器从"页面里的一块"变成整屏、退出时再变回去，
 * 而变换矩阵仍按旧尺寸计算，表现是图偏在一角、底下一排节点被画到画布外。
 * reactflow 把画布宽高放在自己的 store 里，订阅它即可。
 *
 * 给了 `zoom` 就改成定倍 + 左上角对齐：倍数不再随画布大小变，
 * 图从左上角开始铺，装不下的部分靠拖动看。读者因此在任何屏上读到的字号都一样，
 * 代价是一屏未必装得下整张图；这是有意的取舍，不改回 fitView。
 */
function FitOnResize({ zoom }: { zoom?: number }): null {
  const { fitView, setViewport, getNodes } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    if (!width || !height) return;
    // 等这一帧的布局落定再取景：fullscreenchange 当帧拿到的还可能是旧尺寸。
    const raf = requestAnimationFrame(() => {
      if (zoom === undefined) {
        fitView();
        return;
      }
      // 左上角以节点的包围盒为准。边标签会探出这个盒子，但它们四散在图里，
      // 拿它们定位会让原点跟着某一条标签漂移。
      const bounds = getRectOfNodes(getNodes());
      setViewport({
        x: (ANCHOR_PAD - bounds.x) * zoom,
        y: (ANCHOR_PAD - bounds.y) * zoom,
        zoom,
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [width, height, zoom, fitView, setViewport, getNodes]);
  return null;
}

/**
 * 缩放倍数读数，挂在 +/− 这一组控件下面。
 *
 * `fitView` 按画布大小自己定倍数，同一张图在投屏、页面里、抽屉里各是一个值，
 * 读数用来解释字号的变化。
 * 两位小数 + `tabular-nums`：倍数常年小于 1，一位小数分不出 0.36 与 0.44。
 */
function ZoomReadout(): JSX.Element {
  const zoom = useStore((s) => s.transform[2]);
  return (
    <div className="run-flow-zoom" title="当前缩放倍数（取景由画布大小决定）">
      {zoom.toFixed(2)}x
    </div>
  );
}

interface RunFlowProps {
  run: GraphRun;
  /** 默认用固定高度；大屏可交给外层 flex 计算剩余视口高度。 */
  height?: number;
  fit?: boolean;
  /**
   * 定倍取景：给了就按这个倍数、左上角对齐，不再按画布大小自动取景。
   * 小容器（如业务轨迹抽屉）不要给：0.67 在 380px 高的抽屉里只露得出一角。
   */
  zoom?: number;
  className?: string;
}

function RunFlowInner({
  run,
  height = 380,
  fit = false,
  zoom,
  className,
}: RunFlowProps): JSX.Element {
  const key = signature(run);
  const nodes = useMemo(
    () =>
      toNodes(WORKFLOW_NODES, POS, (n) => {
        const hit = run.nodes.get(n.id);
        if (!hit) return { dim: true };
        const active = run.current === n.id;
        return {
          accent: hit.state === "failed" ? FAILED : active ? ACTIVE : DONE,
          pulse: active,
          suffix: [
            active ? "▸ 此刻在这里" : undefined,
            hit.durationMs !== undefined ? `${hit.durationMs}ms` : undefined,
            hit.note,
          ]
            .filter(Boolean)
            .join(" · "),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按内容签名重算，见 signature()
    [key],
  );

  const edges = useMemo(
    () =>
      toEdges(WORKFLOW_EDGES, "r", (e) =>
        // 粒子只给"走过 + 本轮还没收口"的边：收口后的图是记录，不是流。
        edgeWalked(run, e) ? { accent: DONE, particle: !run.finished } : { dim: true },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上
    [key],
  );

  const flowClassName = ["run-flow", className].filter(Boolean).join(" ");
  return (
    <div className={flowClassName}>
      <div
        className="run-flow-canvas"
        style={
          fit
            ? {
                border: "1px solid var(--line, #2a2f3a)",
                borderRadius: 6,
              }
            : {
                height,
                border: "1px solid var(--line, #2a2f3a)",
                borderRadius: 6,
              }
        }
      >
        {/* `minZoom` 必须放开到 0.2：reactflow 默认的 0.5 是缩放下限，
            fitView 算出更小的比例时会被顶回 0.5，多出来的部分直接画到画布外
            （如投屏 1366×768 上底部一排节点被切断）。 */}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          edgeTypes={EDGE_TYPES}
          fitView={zoom === undefined}
          minZoom={0.2}
          nodesDraggable={false}
          nodesConnectable={false}
        >
          <FitOnResize zoom={zoom} />
          {/* 点阵是退后的定位辅助，不应与节点争夺视觉焦点。 */}
          <Background color="rgba(145, 145, 154, 0.28)" gap={24} size={1} />
          <Controls showInteractive={false}>
            <ZoomReadout />
          </Controls>
        </ReactFlow>
      </div>
      <p className="muted tiny">
        亮起的是这一轮真的走过的节点与边，压暗的仍然画着——
        这样看到的是<strong>在整张图上的位置</strong>，而不是一条被抽出来的路径。
        <span style={{ color: DONE }}> ● 走完</span>
        <span style={{ color: ACTIVE }}> ● 此刻在这里</span>
        <span style={{ color: FAILED }}> ● 失败</span>
        {run.unknownNodes.length > 0 ? (
          <>
            {" "}
            ⚠️ 轨迹里还有图上没有的节点：<code>{run.unknownNodes.join("、")}</code>
            ——多半是已下线的旧节点（老会话的回放会有），也可能是图漂了。
          </>
        ) : null}
      </p>
    </div>
  );
}

/**
 * `memo` 是给实时视图的：它每 250ms 换一次 `run`，而大屏上还挂着别的东西。
 * 内容真变了才重画，判据见 `signature`。
 */
export const RunFlow = memo(
  RunFlowInner,
  (a, b) =>
    a.height === b.height &&
    a.fit === b.fit &&
    a.className === b.className &&
    signature(a.run) === signature(b.run),
);
