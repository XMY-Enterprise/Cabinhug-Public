/**
 * 网关连接设置弹层（ACR-004）：只是外壳，表单在 `GatewayForm`。
 *
 * # 用途：iOS 首启引导
 *
 * 日常改地址归底部导航的「设置」页。首启是引导语境，不先教用户认底部导航，
 * 弹层直接把必须填的字段放在他面前。
 *
 * iPad 版没有环境变量：App 由 Swift 壳拉起，`.env` 不存在，默认的 localhost
 * 指向 iPad 自己。不填网关地址就连不上，表现为所有数据为空。
 */
import { GatewayForm } from "./GatewayForm";

import "./settings.css";

export interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  /** 首启引导语境（iOS 第一次打开）：文案从"设置"换成"先连上你的服务器"。 */
  firstRun?: boolean;
}

export function SettingsSheet({ open, onClose, firstRun = false }: SettingsSheetProps) {
  if (!open) return null;

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="网关连接设置">
      <div className="settings-sheet">
        <h2>{firstRun ? "先连上你的服务器" : "网关连接"}</h2>
        <GatewayForm firstRun={firstRun} onCancel={onClose} active={open} />
      </div>
    </div>
  );
}
