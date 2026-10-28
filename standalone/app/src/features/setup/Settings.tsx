/**
 * 设置，两个页签：
 *   密钥      改密钥（与首启同一块「验证并保存」）。服务进程的环境只在启动时生成，改完要重启本地服务。
 *   费用明细  每家服务花了多少、还剩多少（ACR-066）。网关没开这个接口（404）时页签不出现。
 */
import { useEffect, useState } from "react";

import { host } from "../../api";
import type { CredentialGroup } from "../../types";
import { Button, Modal, Segmented } from "../../ui";
import { BillingPanel } from "../billing/BillingPanel";
import { useBilling } from "../billing/useBilling";
import { CredentialGroupCard, type GroupState } from "./CredentialGroupCard";

type Tab = "keys" | "billing";

const TABS = [
  { value: "keys" as const, label: "密钥" },
  { value: "billing" as const, label: "费用明细" },
];

export function Settings({ onClose }: { onClose(): void }) {
  const [tab, setTab] = useState<Tab>("keys");
  const [groups, setGroups] = useState<CredentialGroup[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<Record<string, GroupState>>({});
  const [changed, setChanged] = useState(false);
  const billing = useBilling();
  const billingShown = billing.state.kind !== "unavailable";
  const current = billingShown ? tab : "keys";

  useEffect(() => {
    void host.groups().then(setGroups);
  }, []);

  async function save(g: CredentialGroup) {
    const payload = Object.fromEntries(g.fields.map((f) => [f.env, values[f.env] ?? ""]));
    setState((x) => ({ ...x, [g.group]: { busy: true, verdict: null } }));
    const verdict = await host.save(g.group, payload).catch((e: unknown) => ({ ok: false, reason: String(e) }));
    setState((x) => ({ ...x, [g.group]: { busy: false, verdict } }));
    if (verdict.ok) setChanged(true);
  }

  return (
    <Modal
      title="设置"
      size="wide"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={() => void host.openLogDir()}>
            打开日志目录
          </Button>
          {changed && (
            <Button
              variant="primary"
              onClick={() => {
                void host.restart();
                onClose();
              }}
            >
              重启本地服务使改动生效
            </Button>
          )}
          <Button onClick={onClose}>关闭</Button>
        </>
      }
    >
      {billingShown && <Segmented<Tab> label="设置页签" options={TABS} value={current} onChange={setTab} />}
      {current === "billing" ? (
        <BillingPanel billing={billing} />
      ) : (
        groups.map((g) => (
          <CredentialGroupCard
            key={g.group}
            group={g}
            values={values}
            state={state[g.group]}
            onChange={(env, v) => setValues((x) => ({ ...x, [env]: v }))}
            onSave={() => void save(g)}
          />
        ))
      )}
    </Modal>
  );
}
