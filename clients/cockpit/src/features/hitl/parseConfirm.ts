/**
 * 确认弹层的明细解析随弹层搬到了 `@cabinhug/ui`（clients/shared/ui/src/hitl/parseConfirm.ts）。
 * 这里只留转发，车机端测试的引用不用改。走纯逻辑子路径 `@cabinhug/ui/confirm`：包根会带上图片资源，
 * node:test 加载不了 `.png`。
 */
export { parseConfirm, scopeLabel } from "@cabinhug/ui/confirm";
export type { ConfirmView, PlanDay, PlanStay, TransitBlock, TransitOption } from "@cabinhug/ui/confirm";
