/**
 * 改名前的环境变量名（ACR-051）：`CARLIFE_*` → `CABINHUG_*`。
 *
 * 代码里只读新名。已有的 `.env`、线上部署与开发机 shell 仍可能只有旧名，
 * 所以进程入口调用一次 `bridgeLegacyEnv(process.env)`，把旧名的值搬到新名上，
 * 而不是在各读取点写"新名 ?? 旧名"，这样弃用日志也能统一打。
 *
 * # 显式名单而不是前缀通配
 *
 * 通配会把拼错的旧变量也静默接住。名单外的旧名不搬，
 * 读取方拿到的就是缺省值，与改名前拼错变量名的表现一致。
 *
 * 退休的 `CARLIFE_ASR`、`CARLIFE_TTS` 不在名单里：它们已不生效，
 * 读取点只为对旧名打"已废弃"告警，改名后仍按旧名告警。
 */

const LEGACY_PREFIX = "CARLIFE_";
const CURRENT_PREFIX = "CABINHUG_";

/** 改名映射表：两边前缀之后的部分完全相同，所以只列后缀。新增变量不用往这里加。 */
export const RENAMED_ENV_SUFFIXES: readonly string[] = [
  "ADMIN_TOKEN", "AEC_DELAY_MS", "AEC_ENABLED", "AGENT_RUNTIME", "ALERT_CATALOG_ROOT",
  "ANSWER_MODEL", "ANSWER_RUNTIME", "ANSWER_TIMEOUT_MS", "APP_DIR", "ASR_FAKE_TEXT",
  "ASR_MODEL_VOLUME", "CHECKPOINTER", "CONFIG_MASTER_KEY", "CONFIG_TTL_MS",
  "CONTEXT_CACHE_TTL_S", "CONTEXT_LAYER", "DEMO_TOKEN", "DEV_INFRA_LOCAL_ASR_READY",
  "DEV_INFRA_TIMEOUT_SECONDS", "DEV_PASSWORD", "DEV_TMUX_SESSION",
  "DEV_UPGRADE_BOOTSTRAP_TIMEOUT", "DRILL_KEEP", "DRIVE_DAILY_MAX_MIN",
  "DRIVE_LEG_SAFE_MAX_MIN", "ENV", "EVALS_ROOT", "EVIDENCE_SINCE", "FINANCE_BILLS_TTL_MS",
  "FINANCE_DANGER_CNY", "FINANCE_HISTORY", "FINANCE_HISTORY_FILE",
  "FINANCE_HISTORY_INTERVAL_MIN", "FINANCE_STATE_FILE", "FINANCE_TIMEOUT_MS",
  "FINANCE_TTL_MS", "FINANCE_WARN_CNY", "GATEWAY_URL", "GENERAL_SCOPE",
  "HOST_SERVICES_HOST", "HOTEL_GAP_KM", "ICON_EMBED_MODEL", "ICON_IMAGES_ROOT", "ICON_INDEX",
  "IMAGE_PREFIX", "IMAGE_TAG", "JWT_SECRET", "KB_FIGURES", "KB_FIGURES_ROOT",
  "KB_FIGURES_STORE", "LLM", "LLM_FAKE_TAG", "LOCAL_ASR_IMAGE", "MEM0_IT",
  "NODE_PREFLIGHT_DONE", "OPS_TOKEN", "PG_CONTAINER", "PII_MASTER_KEY", "PI_AGENT",
  "PI_ANSWER_THINKING", "PI_APPEND_PROMPT", "PI_MODEL", "PI_TOOLS", "PLAN_AUDIT_BUDGET_MS",
  "PLAN_AUDIT_MAX_ROUNDS", "PLAN_AUDIT_STALL_ROUNDS", "PROBE_RATE_LIMIT",
  "QDRANT_BACKUP_DIR", "SCRATCH", "SENTINEL_DEBUG", "SERVICE_ASKS", "SESSION_IDLE_MIN",
  "SIDE_TASKS", "SMOKE_TOKEN", "TITLE_MODEL", "TOOLS", "TOOLS_ENDPOINT", "TOUR_TWO_STAGE",
  "TRIP_CLARIFY", "TRIP_PLAN_LAYER", "TTS_SAY_VOICE", "VISION", "VISION_DESCRIBE_MODEL",
  "VISION_DESCRIBE_PROVIDER", "VISION_DETECT_MODEL", "VISION_DETECT_PROVIDER",
  "VISION_FIXTURES", "VISION_YOLO_CONF", "VISION_YOLO_IMGSZ", "VISION_YOLO_MODEL",
  "WEATHER_CMA",
];

export interface LegacyEnvName {
  legacy: string;
  current: string;
}

export const LEGACY_ENV_NAMES: readonly LegacyEnvName[] = RENAMED_ENV_SUFFIXES.map((suffix) => ({
  legacy: LEGACY_PREFIX + suffix,
  current: CURRENT_PREFIX + suffix,
}));

/**
 * `copied`：旧名在用，新名按它的值生效——包括新名已由上游（dev.sh 的 shell 桥接）搬好、两边值相同的情况。
 * `ignored`：新旧都设了且值不同，新名生效、旧名被忽略。
 */
export interface LegacyEnvNotice {
  legacy: string;
  current: string;
  action: "copied" | "ignored";
}

type MutableEnv = Record<string, string | undefined>;

/**
 * 把旧名的值搬到新名上，返回每一处用到旧名的记录。只改 `env`，不打印——
 * 打印由调用方决定（服务入口 `console.warn`，测试断言返回值）。
 * 空串视为"设了"：`.env` 里写 `CARLIFE_X=` 的含义是显式置空，与改名前一致。
 */
export function bridgeLegacyEnv(env: MutableEnv): LegacyEnvNotice[] {
  const notices: LegacyEnvNotice[] = [];
  for (const { legacy, current } of LEGACY_ENV_NAMES) {
    const legacyValue = env[legacy];
    if (legacyValue === undefined) continue;
    const currentValue = env[current];
    if (currentValue === undefined) env[current] = legacyValue;
    const action = currentValue === undefined || currentValue === legacyValue ? "copied" : "ignored";
    notices.push({ legacy, current, action });
  }
  return notices;
}

/** 弃用日志的统一措辞；不含变量值（其中有密钥）。 */
export function describeLegacyEnvNotice(notice: LegacyEnvNotice): string {
  if (notice.action === "copied") {
    return `[config] 环境变量 ${notice.legacy} 已弃用，本次按 ${notice.current} 生效；请改用新名`;
  }
  return `[config] 环境变量 ${notice.legacy} 已弃用且被忽略：${notice.current} 已设置，以新名为准`;
}
