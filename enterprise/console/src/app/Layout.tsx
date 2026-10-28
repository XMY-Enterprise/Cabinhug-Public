/**
 * 布局壳：左侧导航 + 顶部身份/环境标识 + 内容区。
 *
 * 顶部的环境标识用于防止连错环境而不自知（US-43 场景 8 的后台侧）。
 *
 * # 导航分组
 *
 * 按使用目的分组：看大盘 / 看发生了什么 / 查安全 / 查钱 / 改配置，
 * 把线性扫描变成"先定组、再定行"。
 * 顺序按访问频率与后果排：最常看的在最上面，改动影响最大的在最下面。
 *
 * 组名用极轻的字重与颜色：它们是路标，不应抢过内容。
 */

import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

import type { ConsoleIdentity } from "../api";
import { NavIcon } from "./nav-icons";

interface NavItem {
  to: string;
  label: string;
  adminOnly?: boolean;
  /** 本 Sprint 未建设的页面：菜单可见但标灰，避免"点了没反应"的困惑 */
  pending?: string;
  /** 精确匹配：父路径与子路径同组时，父项不该因子页面而一并高亮 */
  end?: boolean;
}

interface NavGroup {
  /** 组名。按使用目的命名，不是分类学。 */
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    // 打开后台第一眼要看的：服务活没活、演示那块屏、图跑到哪一步。
    // 「系统状态」排第一条：连错环境或服务没起时，其余页面的读数都不可信。
    title: "总览",
    items: [
      // 运维大屏：子服务探活一览（清单是 infra/dev.sh + docker-compose 的投影）
      { to: "/system", label: "系统状态" },
      { to: "/demo", label: "演示大屏" },
      { to: "/workflow", label: "Workflow" },
    ],
  },
  {
    title: "运营观测",
    items: [
      { to: "/sessions", label: "会话与对话" },
      { to: "/memory", label: "记忆浏览" },
      // 知识库紧跟记忆浏览：一个是"这辆车/这个人"的记忆，一个是"所有车"的资料，
      // 都是模型回答时的取材来源，排查"它为什么这么答"时会连着看
      { to: "/knowledge", label: "知识库" },
      { to: "/cabin", label: "客户座舱" },
      { to: "/trace", label: "轨迹回放" },
    ],
  },
  {
    // 评测自成一组：它是用题库度量系统而不是观测线上，
    // 起任务、看分数、翻逐题，与运营观测的读数页是两种动作。
    title: "评测",
    items: [
      { to: "/evals", label: "评测任务", end: true },
      // 基线 = 仓库提交的那份产物，是所有新任务的对照物，所以单独给一个入口
      { to: "/evals/baseline", label: "基线报告" },
      // 模型训练（ACR-026）：警示灯小检测器的工作台，也是用数据度量系统，跟评测放一组
      { to: "/vision-trainer", label: "模型训练" },
    ],
  },
  {
    // 客服查询面：找到这个人 → 看他名下有什么。访问频率仅次于会话，动作有后果但可逆，
    // 所以排在「运营观测」之后、「安全与审计」之前。三条对应"人 / 车 / 设备"三个维度。
    title: "用户体系",
    items: [
      { to: "/identity/users", label: "账号" },
      { to: "/identity/vehicles", label: "车辆与授权" },
      { to: "/identity/devices", label: "终端设备" },
    ],
  },
  {
    // 用户研究：紧跟「用户体系」，形成"个体 → 总体"：
    // 那边是找到一个人及其名下资产，这边是所有车主反复提到的需求。
    // 五页共享同一套顶部状态（观察总体 / 时间窗 / codebook 版本 / 四道硬门），
    // 形态与判据在 内部文档
    title: "用户研究",
    items: [
      { to: "/research/evidence-matrix", label: "证据矩阵" },
      { to: "/research/importance-performance", label: "重要度×表现度" },
      { to: "/research/emotion-job-map", label: "情绪×任务地图" },
      { to: "/research/segment-atlas", label: "人群分群图谱" },
      { to: "/research/trend-signal", label: "趋势与信号" },
    ],
  },
  {
    title: "安全与审计",
    items: [
      // 运营可写：出事时运营要能立刻按下止血开关，不必等管理员
      { to: "/guard", label: "内容安全策略" },
      { to: "/audit", label: "操作审计" },
    ],
  },
  {
    title: "用量与财务",
    items: [
      { to: "/usage", label: "用量与成本" },
      // 财务与用量分开两条：一个是供应商那边的余额，一个是我们自己记的花费，
      // 塞进同一页会让人以为它们能相减；但放同一组——查钱的人两条都要看
      { to: "/finance", label: "财务", adminOnly: true },
    ],
  },
  {
    // 排最后：改配置是最少发生、后果最重的动作，不该在顺手够得着的位置
    title: "配置",
    items: [{ to: "/config", label: "系统配置", adminOnly: true }],
  },
];

const ENV_LABEL = import.meta.env.MODE === "production" ? "production" : "local";

export function Layout({
  identity,
  onSignOut,
  children,
}: {
  identity: ConsoleIdentity;
  onSignOut: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="shell">
      <aside className="shell-nav">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            {/* 方向盘：能识别为车，且在 20px 上仍清晰 */}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M12 3v6M4.2 16.5l5.2-3M19.8 16.5l-5.2-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="brand-text">
            Cabinhug <span className="brand-sub">Console</span>
          </span>
        </div>

        <nav>
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter((i) => !i.adminOnly || identity.role === "admin");
            // 整组被角色过滤空了就连组名一起收起，不留空标题，
            // 否则会被误认为该组页面加载失败。
            if (items.length === 0) return null;
            return (
              <div className="nav-group" key={group.title}>
                <div className="nav-group-title">{group.title}</div>
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      ["nav-item", isActive ? "is-active" : "", item.pending ? "is-pending" : ""].join(" ")
                    }
                  >
                    <NavIcon to={item.to} />
                    <span className="nav-label">{item.label}</span>
                    {item.pending ? <span className="nav-tag">待建设</span> : null}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="shell-main">
        <header className="shell-top">
          {/*
            header 不重复页名：每页的 `h1` 已写明。
            顶栏只放跨页恒定的信息：连的是哪套环境、当前是谁。
          */}
          <span className="spacer" />
          <span className={`env-badge env-${ENV_LABEL}`}>
            <i className="env-dot" aria-hidden="true" />
            {ENV_LABEL}
          </span>
          <span className="identity">
            {identity.subject}
            <span className={`role-badge role-${identity.role}`}>{identity.role}</span>
          </span>
          <button type="button" className="btn-link" onClick={onSignOut}>
            退出
          </button>
        </header>
        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}
