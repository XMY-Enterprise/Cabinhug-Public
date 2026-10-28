/**
 * 一组密钥（DeepSeek / 阿里云 / 高德）：说明、掩码输入、「去申请」「验证并保存」、状态。
 * 首启与设置共用这一块。编辑框是「写入新值」：已存过的只显示「已保存」，不回显任何值。
 */
import { host } from "../../api";
import type { CredentialGroup, Verdict } from "../../types";
import { Button, Card, Field } from "../../ui";
import s from "./CredentialGroupCard.module.css";

export const APPLY: Record<string, { url: string; hint: string }> = {
  deepseek: { url: "https://platform.deepseek.com/api_keys", hint: "对话与行程规划用的大模型，按用量计费" },
  "aliyun-guard": { url: "https://ram.console.aliyun.com/manage/ak", hint: "检查输入与回复的内容安全，需开通 AI 安全护栏（华东 2 上海）" },
  amap: { url: "https://console.amap.com/dev/key/app", hint: "两种 Key 要在高德控制台分别创建，不能互换；Web 服务 Key 需关闭数字签名" },
};

export type GroupState = { busy: boolean; verdict: Verdict | null };

export function CredentialGroupCard({
  group,
  values,
  state,
  onChange,
  onSave,
}: {
  group: CredentialGroup;
  values: Record<string, string>;
  state: GroupState | undefined;
  onChange(env: string, value: string): void;
  onSave(): void;
}) {
  const apply = APPLY[group.group];
  return (
    <Card variant="inset" padding="md" as="section" className={s.group}>
      <h3 className={s.title}>{group.label}</h3>
      {apply && <p className={s.hint}>{apply.hint}</p>}
      {group.fields.map((f) => (
        <Field
          key={f.env}
          label={f.label}
          type="password"
          autoComplete="off"
          placeholder={group.saved ? "已保存（填写即替换）" : ""}
          value={values[f.env] ?? ""}
          onChange={(e) => onChange(f.env, e.target.value)}
        />
      ))}
      <div className={s.actions}>
        {apply && (
          <button type="button" className={s.link} onClick={() => void host.openApplyPage(apply.url)}>
            去申请
          </button>
        )}
        <Button disabled={state?.busy || group.fields.some((f) => !(values[f.env] ?? "").trim())} onClick={onSave}>
          验证并保存
        </Button>
        {state?.busy ? (
          <span className={s.running}>验证中…</span>
        ) : state?.verdict && !state.verdict.ok ? (
          <span className={s.failed}>验证失败：{state.verdict.reason}</span>
        ) : group.saved || state?.verdict?.ok ? (
          <span className={s.ok}>✓ 已验证</span>
        ) : (
          <span className={s.idle}>未填写</span>
        )}
      </div>
    </Card>
  );
}
