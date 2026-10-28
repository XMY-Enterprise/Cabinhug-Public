/**
 * 首启设置（UI-02 第 1 屏）：三组密钥「验证并保存」+ 右侧本地服务启动进度。
 */
import { useEffect, useState } from "react";

import { host } from "../../api";
import type { CredentialGroup, HostStatus } from "../../types";
import { Button, Card, cx, StatusDot } from "../../ui";
import { CredentialGroupCard, type GroupState } from "./CredentialGroupCard";
import s from "./Setup.module.css";

const STEP_STATE = { done: "✓", running: "进行中", failed: "失败", waiting: "等待" } as const;

export function Setup({ status, onEnter }: { status: HostStatus | null; onEnter(): void }) {
  const [groups, setGroups] = useState<CredentialGroup[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<Record<string, GroupState>>({});

  const reload = () => host.groups().then(setGroups).catch(() => undefined);
  useEffect(() => {
    void reload();
  }, []);

  const allSaved = groups.length > 0 && groups.every((g) => g.saved);
  const phase = status?.phase ?? "idle";
  useEffect(() => {
    // 三组都存好了而服务还没起（或上次失败）就起；起的过程由状态轮询画出来。
    if (allSaved && (phase === "needs-credentials" || phase === "idle" || phase === "stopped")) void host.start();
  }, [allSaved, phase]);

  async function save(g: CredentialGroup) {
    const payload: Record<string, string> = {};
    for (const f of g.fields) payload[f.env] = values[f.env] ?? "";
    setState((x) => ({ ...x, [g.group]: { busy: true, verdict: null } }));
    try {
      const verdict = await host.save(g.group, payload);
      setState((x) => ({ ...x, [g.group]: { busy: false, verdict } }));
      if (verdict.ok) {
        setValues((v) => {
          const next = { ...v };
          for (const f of g.fields) delete next[f.env];
          return next;
        });
        await reload();
      }
    } catch (err) {
      setState((x) => ({ ...x, [g.group]: { busy: false, verdict: { ok: false, reason: String(err) } } }));
    }
  }

  const ready = phase === "ready";
  const stepDone = (id: string) => status?.steps.find((x) => x.id === id)?.state === "done";
  const missing = groups.filter((g) => !g.saved).map((g) => g.label);
  const stepper = [
    { label: "① 填写密钥", state: allSaved ? "done" : "active" },
    { label: "② 启动本地服务", state: ready ? "done" : allSaved ? "active" : "todo" },
    { label: "③ 开始规划", state: ready ? "active" : "todo" },
  ] as const;

  return (
    <div className={s.page}>
      <Card variant="float" padding="lg" className={s.card}>
        <ol className={s.stepper}>
          {stepper.map((x) => (
            <li key={x.label} className={s[x.state]}>
              {x.label}
            </li>
          ))}
        </ol>
        <div className={s.body}>
          <div className={s.groups}>
            {groups.map((g) => (
              <CredentialGroupCard
                key={g.group}
                group={g}
                values={values}
                state={state[g.group]}
                onChange={(env, v) => setValues((x) => ({ ...x, [env]: v }))}
                onSave={() => void save(g)}
              />
            ))}
          </div>
          <Card variant="inset" padding="md" as="aside" className={s.services}>
            <h3 className={s.servicesTitle}>本地服务</h3>
            {(status?.steps ?? []).map((x) => (
              <div key={x.id} className={cx(s.service, s[`step-${x.state}`])} title={x.detail ?? undefined}>
                <span className={s.serviceName}>
                  <StatusDot tone={x.state === "done" ? "ok" : x.state === "running" ? "busy" : x.state === "failed" ? "danger" : "idle"} />
                  {x.label}
                </span>
                <span className={s.serviceState}>{STEP_STATE[x.state]}</span>
              </div>
            ))}
            {phase === "failed" && (
              <div className={s.failed}>
                <p>{status?.message}</p>
                <div className={s.failedActions}>
                  <Button size="sm" onClick={() => void host.start()}>
                    重试
                  </Button>
                  <button type="button" className={s.link} onClick={() => void host.openLogDir()}>
                    打开日志目录
                  </button>
                </div>
              </div>
            )}
          </Card>
        </div>
        <footer className={s.footer}>
          <span className={s.muted}>密钥只保存在本机钥匙串（Windows：凭据管理器），不上传</span>
          <div className={s.go}>
            <Button variant="primary" shape="pill" size="lg" disabled={!ready} onClick={onEnter}>
              开始使用
            </Button>
            {!ready && (
              <span className={s.muted}>
                {missing.length ? `还差：${missing.join("、")}` : stepDone("selfcheck") ? "" : "本地服务启动中，稍等…"}
              </span>
            )}
          </div>
        </footer>
      </Card>
    </div>
  );
}
