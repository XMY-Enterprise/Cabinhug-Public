/**
 * 能力开关的读取口（ACR-056）。网关与编排层各读一次，同一个口径。
 *
 * 经 ConfigStore 读：env-override 钉档、后台改值、30 秒缓存都由它处理。
 * 配置层抛错（库连不上且没有缓存）时退回只读环境变量：本地一体版的钉档就在 env 里，
 * 不能因为库抖一下就把关掉的能力放出来；分离部署不设 env，退回的结果是「都不关」，与现状一致。
 */

import { parseCapabilitiesOff, type Capability } from "@cabinhug/shared";

import type { ConfigStore } from "./store";

export const CAPABILITIES_OFF_KEY = "CABINHUG_CAPABILITIES_OFF";

export async function readCapabilitiesOff(
  store: Pick<ConfigStore, "get">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Set<Capability>> {
  try {
    return parseCapabilitiesOff(await store.get(CAPABILITIES_OFF_KEY));
  } catch (err) {
    console.error(`[capabilities] 配置读取失败，退回环境变量 ${CAPABILITIES_OFF_KEY}`, err);
    return parseCapabilitiesOff(env[CAPABILITIES_OFF_KEY]);
  }
}
