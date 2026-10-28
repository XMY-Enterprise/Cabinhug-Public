/**
 * 魔搭创空间的落地页（ACR-049）。
 *
 * 它只做一件事：把访客送进两端的真界面，不另做一个演示用的对话页，
 * 以免访客把演示页当成产品。
 *
 * 页面上只有两张入口卡，截图就是卡面——访客看到的是"这个界面长什么样"，
 * 点下去进的就是它。
 *
 * 对话、语音、确认卡那些能力都在 `/mobile/` 与 `/cockpit/` 里，走的是两端自己的代码。
 */

import { config } from "./config.ts";

const SURFACES = [
  {
    key: "cockpit",
    href: "pad.html",
    title: "车机端",
    shot: "/showcase/screenshot-cockpit.jpg",
    detail: "HUD、地图与行程、助手形象。左下角「长按说话」，说完松手即可。",
  },
  {
    key: "mobile",
    href: "phone.html",
    title: "手机端",
    shot: "/showcase/screenshot-mobile.jpg",
    detail: "拍照问诊、对话、车辆档案。拍一张仪表盘，不用打字。",
  },
];

export default function App() {
  return (
    <div className="app landing">
      {config.notice ? <div className="notice">{config.notice}</div> : null}

      <header>
        <h1>Cabinhug</h1>
        <span className="tagline">面向车主全生命周期的用车智能体</span>
        <span className="build" title="镜像构建时间">{config.buildId}</span>
      </header>

      <main>
        <div className="surfaces">
          {SURFACES.map((s) => (
            <a key={s.key} className={`surface surface-${s.key}`} href={s.href}>
              <span className="shot">
                <img src={s.shot} alt={`${s.title}界面`} />
              </span>
              <span className="meta">
                <strong>{s.title}</strong>
                <span className="cta">点击进入 →</span>
              </span>
              <span className="detail">{s.detail}</span>
            </a>
          ))}
        </div>
      </main>
    </div>
  );
}
