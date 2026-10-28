/**
 * clients/shared/ui/src/components — 跨端通用组件（尚未实现）。
 *
 * 目录为空但需保留：它是 4 个功能点指定的落点，其中 2 个是 P0。
 *
 * # 与同级目录的分工
 *
 * `clients/shared/ui` 下已有内容的是场景化目录（`hud/`、`map/`、`assistant-avatar/`、
 * `themes/`、`hooks/`），各自服务一个具体场景。本目录放跨场景复用的通用件
 * （弹窗、折叠面板、详情卡）。它尚未进入 `src/index.ts` 的导出，
 * 以免空导出让人误以为已有通用组件。
 *
 * 补齐时需同时把 `export * from "./components"` 加进 `src/index.ts`，
 * 否则消费方 import 不到。
 *
 * # 待落地的功能点
 *
 * | 功能点 | 要求 |
 * |---|---|
 * | F-04-01 (P0) | 跨层确认弹窗组件，层级高于 HUD 与对话层（overlay/portal，不依赖路由层级） |
 * | F-04-02 (P0) | 动作明细渲染，不只显示动作名；与 `appointment` 的 `describeDisclosure()` 对接，逐项列出将外发的信息 |
 * | F-03-04 | 思考过程折叠展开 |
 * | F-03-05 | 方案详情卡片展开 |
 */

export {};
