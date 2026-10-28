/**
 * `.env.example` 与配置注册表的双向一致性检查（AC-35-10）。
 *
 * 运行：`corepack pnpm check:env-example`
 *
 * 模板缺一项，照模板填写的环境就起不来，因此缺项即缺陷。
 */

import { readFileSync } from "node:fs";

import { CONFIG_REGISTRY } from "@cabinhug/db";

const ROOT = new URL("../../../", import.meta.url);
const template = readFileSync(new URL(".env.example", ROOT), "utf8");

/*
 * 匹配 `KEY=` 与被注释掉的 `# KEY=`（可选项同样算"模板里有"）。
 *
 * 键名允许混合大小写：仓里绝大多数是 ALL_CAPS，但第三方约定的名字不由本仓决定，
 * 如阿里云的 `Aliyun_AccessKey_ID`（见 内部文档）。
 * 本检查只拦"注册表加了项却没写进模板"，不管命名风格。
 */
const declared = new Set(
  [...template.matchAll(/^#?\s*([A-Za-z][A-Za-z0-9_]*)=/gm)].map((m) => m[1]),
);

const missing = CONFIG_REGISTRY.filter((d) => !declared.has(d.envFallback));

let failed = false;

if (missing.length > 0) {
  failed = true;
  console.error("✗ .env.example 缺少以下注册表项（缺一行即缺陷）：");
  for (const d of missing) {
    console.error(`  - ${d.envFallback}  # ${d.description}`);
  }
} else {
  console.log(`✓ 注册表 ${CONFIG_REGISTRY.length} 项均在 .env.example 中声明`);
}

// 反向：模板里有、注册表里没有的项 —— 只警告不失败
// （端口、DATABASE_URL 之类的引导项允许存在于模板但不进注册表）
const known = new Set(CONFIG_REGISTRY.map((d) => d.envFallback));
const extra = [...declared].filter(
  (k) => !known.has(k) && !/^(GATEWAY_PORT|AGENT_RUNTIME_PORT|AGENT_RUNTIME_URL|CABINHUG_GATEWAY_URL|CABINHUG_DEMO_TOKEN|CABINHUG_ASR_FAKE_TEXT|CABINHUG_TTS_SAY_VOICE|CABINHUG_AEC_ENABLED|CABINHUG_AEC_DELAY_MS|CABINHUG_SENTINEL_DEBUG|CABINHUG_CONFIG_TTL_MS|CABINHUG_AGENT_RUNTIME|CABINHUG_ANSWER_RUNTIME|CABINHUG_ANSWER_MODEL|CABINHUG_TITLE_MODEL|CABINHUG_PROBE_RATE_LIMIT|TAURI_APPLE_DEVELOPMENT_TEAM|TEST_DATABASE_URL)$/.test(k),
);
if (extra.length > 0) {
  console.warn(`⚠ 模板中有、注册表中无：${extra.join(", ")}（如属配置项请补进注册表）`);
}

process.exit(failed ? 1 : 0);
