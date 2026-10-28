/**
 * RAGFlow 数据集定义（§6 知识库划分）。
 *
 * 四个数据集严格隔离（AC-24-8）：用车助手检索不到维修知识库的内容。
 * 隔离靠 `dataset_id` 在调用层强制，不靠 prompt 提醒。
 *
 * # 归属规则：按消费方分，不按文档类型分
 *
 * 隔离是硬的，放错时该看到它的 Agent 看不到、不该看到的反而能看到。
 *
 * 判据是"什么场景下的人会去翻它"：
 *
 *   vehicle-manuals  "这个功能怎么用"          —— 日常用车会翻的那本
 *   repair-kb        "出问题了怎么办 / 该保养了吗" —— 带着症状或周期去查的
 *   car-catalog      "买哪款"                  —— 还没有这辆车时看的
 *   insurance-kb     "出险了该怎么办 / 这单该不该走保险 / 保单里写了什么"
 *                                             —— 售后与购车两边都会翻（ACR-040）
 *
 * 边界规则：
 *  - 保养手册进 repair-kb 不进 vehicle-manuals。保养是售后的业务面
 *    （周期推算、预约、工单），不是"功能怎么用"。
 *  - 配置参数进 car-catalog 不进 vehicle-manuals。已经买了车的人
 *    不会去查"这一款有哪些配置可选"。
 *  - 理赔材料清单进 insurance-kb 不进 repair-kb。它回答的是
 *    "保险公司要什么"，不是"车怎么修"。insurance-kb 独立成集是因为
 *    消费方与 repair-kb 不同：买车时也要看条款。
 *
 * `consumers` 是权限清单，不是检索范围（ACR-042）。它回答"谁可以查"，
 * 缺省查哪些由工具层决定：`ragflow_retrieve` 不指定 dataset 时查该 Agent 允许的全部集。
 * 数组顺序没有语义，第一项不是默认集。
 *
 * # 作用域：这个集按什么键分区
 *
 * 车型过滤（F-23-07）只对按车型分区的集成立。行业级的示范条款不属于任何一款车，
 * 按车型筛必然零匹配，这不代表没有资料。
 *
 *   per-model  文档按车型分区。带车型检索必须落到这辆车的文档上，零匹配是错误
 *              （抛 NoDocumentsForModelError，不退回全库）。
 *   shared     文档对所有车型有效。文件名不含任何目录车型的对所有车可见；
 *              含车型的只对那款车可见（如特斯拉专属的出险注意事项）。零可见不是错误。
 */

export type DatasetKey = "vehicle-manuals" | "repair-kb" | "car-catalog" | "insurance-kb";

export interface DatasetDef {
  key: DatasetKey;
  /** RAGFlow 侧的 dataset id，由配置注入（不同环境不同）。 */
  envKey: string;
  name: string;
  /** 消费方：按 §4.3 能力映射，是权限清单，见文件头。 */
  consumers: readonly string[];
  /**
   * 这个集按什么键分区（ACR-042）。取值含义见文件头；
   * 新集必须显式声明，否则车型过滤可能该生效不生效、或不该生效却生效。
   */
  scope: "per-model" | "shared";
  /**
   * 数据来源标注（F-24-11）：真实公开资料还是模拟数据。
   * 模拟数据不冒充真实厂商数据；取值跟着实际内容走。
   */
  provenance: "public" | "simulated";
}

export const DATASETS: readonly DatasetDef[] = [
  {
    key: "vehicle-manuals",
    envKey: "RAGFLOW_DATASET_VEHICLE_MANUALS",
    name: "车辆说明书",
    consumers: ["ownership"],
    scope: "per-model",
    provenance: "public",
  },
  {
    key: "repair-kb",
    envKey: "RAGFLOW_DATASET_REPAIR_KB",
    name: "维修与保养手册",
    consumers: ["service"],
    scope: "per-model",
    // 装的是厂商的保修及保养手册（真实公开资料），不是编造的维修案例。
    provenance: "public",
  },
  {
    key: "car-catalog",
    envKey: "RAGFLOW_DATASET_CAR_CATALOG",
    name: "车型参数库",
    consumers: ["buying"],
    scope: "per-model",
    provenance: "public",
  },
  {
    key: "insurance-kb",
    envKey: "RAGFLOW_DATASET_INSURANCE_KB",
    name: "车险条款与理赔指引",
    // 售后（出险了怎么办）与购车（投保前看条款）两边都翻；两边缺省都会查它（ACR-042）。
    consumers: ["service", "buying"],
    // 中保协示范条款是行业级的，不属于任何一款车，按车型筛必然零匹配。
    scope: "shared",
    // 主干是中保协示范条款与险企公开的理赔指引（真实公开资料）。
    // 若语料工单混入自写的流程整理稿，按"跟着实际内容走"回来复核这一栏。
    provenance: "public",
  },
];

export function datasetFor(key: DatasetKey): DatasetDef {
  const d = DATASETS.find((x) => x.key === key);
  if (!d) throw new Error(`未定义的数据集：${key}`);
  return d;
}

/** 某 Agent 能查哪些数据集：跨集检索在这里被挡住，不靠 prompt。 */
export function datasetsForAgent(agent: string): readonly DatasetDef[] {
  return DATASETS.filter((d) => d.consumers.includes(agent));
}

/** `datasetsForAgent` 的 key 投影：工具层与自检脚本只需要 key 列表。 */
export function datasetKeysForAgent(agent: string): DatasetKey[] {
  return datasetsForAgent(agent).map((d) => d.key);
}

/**
 * 从环境变量取全部数据集 id：`createRagClient({ datasetIds })` 的唯一来源。
 *
 * 各调用方（网关、worker、runtime、kb 脚本、探针、自检、评测）都从 `DATASETS` 的
 * `envKey` 派生，不各自手写映射；手写映射漏掉某个集时不报错，只让那个集不可用。
 *
 * 取不到的键留空串，由 `createRagClient` 在真正用到那个集时报
 * 「未配置 id（<envKey>）」，而不是在启动时拒绝整个客户端：
 * 少配一个集不影响其余集。
 */
export function datasetIdsFromEnv(
  read: (key: string) => string | undefined = (k) => process.env[k],
): Record<DatasetKey, string> {
  const out = {} as Record<DatasetKey, string>;
  for (const d of DATASETS) out[d.key] = read(d.envKey)?.trim() ?? "";
  return out;
}
