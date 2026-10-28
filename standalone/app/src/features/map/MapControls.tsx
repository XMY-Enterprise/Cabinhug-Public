/** 右下缩放钮。「回到全程」由共享地图层自己出（动过镜头才出现），这里不重复一个。 */
import { Button } from "../../ui";
import s from "./MapControls.module.css";

export function MapControls({ onZoomIn, onZoomOut }: { onZoomIn(): void; onZoomOut(): void }) {
  return (
    <div className={s.stack}>
      <Button variant="float" icon="plus" label="放大" onClick={onZoomIn} />
      <Button variant="float" icon="minus" label="缩小" onClick={onZoomOut} />
    </div>
  );
}
