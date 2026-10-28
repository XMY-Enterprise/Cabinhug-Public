/**
 * 测试库地址的唯一解析入口。
 *
 * # 不直接读 `DATABASE_URL`
 *
 * 测试会清理数据（如 `e2e:dualpath` 的准备阶段
 * `deleteMany({ ownerId: "demo-user" })`，与 `demo:seed` 同一个 userId），
 * 与开发库共用会清掉演示数据。
 *
 * # 不回落到 `DATABASE_URL`
 *
 * `TEST_DATABASE_URL ?? DATABASE_URL` 的回落不会以失败的形式暴露：
 * 两个变量都配着时测试照常通过，隔离却没有生效。
 * 所以缺配置时用下面这个测试库的字面默认值，不读 `DATABASE_URL`。
 *
 * # `_test` 后缀是运行期强制的不变量，不是命名约定
 *
 * 把变量指回开发库时不会有任何现象，所以这里直接拒绝执行。
 * 与 RAG 的数据集隔离一样，由调用层强制，不靠约定。
 */

/** 没配 `TEST_DATABASE_URL` 时用它。与开发库同实例不同库，隔离在库这一层。 */
const DEFAULT_TEST_DATABASE_URL = "postgresql://carlife:carlife@localhost:55433/carlife_test";

/** 库名必须以它结尾。改这个后缀等于改一条不变量。 */
const REQUIRED_SUFFIX = "_test";

export class TestDatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseUrlError";
  }
}

/** 从连接串里取库名：path 去掉前导 `/`，查询串由 URL 解析天然剥离。 */
function databaseNameOf(url: URL): string {
  return url.pathname.replace(/^\//, "");
}

/**
 * 解析并校验测试库地址。返回值是已经过 `_test` 校验的 URL，
 * 调用方可以直接连，不需要再检查。
 *
 * @throws {TestDatabaseUrlError} URL 解析不了，或库名不以 `_test` 结尾
 */
export function resolveTestDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  // 只看 TEST_DATABASE_URL，不看 DATABASE_URL（理由见文件头）。
  const raw = env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // 解析不了就抛，不静默退回默认值：否则拼错的连接串会让测试
    // 跑在默认库上而不是预期的库。
    throw new TestDatabaseUrlError(
      `TEST_DATABASE_URL 不是合法的连接串：${raw}\n` +
        `期望形如 ${DEFAULT_TEST_DATABASE_URL}`,
    );
  }

  const name = databaseNameOf(parsed);
  if (!name.endsWith(REQUIRED_SUFFIX)) {
    throw new TestDatabaseUrlError(
      `拒绝在库「${name}」上跑测试：库名必须以 ${REQUIRED_SUFFIX} 结尾。\n` +
        `这道闸挡的是"测试连上开发库"——测试会删数据（如 e2e 会清掉 demo-user 的车辆与行程）。\n` +
        `把 TEST_DATABASE_URL 指向测试库（默认 ${DEFAULT_TEST_DATABASE_URL}），` +
        `并先跑一次 corepack pnpm db:test:setup 建好它。`,
    );
  }

  return raw;
}

export { DEFAULT_TEST_DATABASE_URL };

/*
 * 按包分库（TD-60）。
 *
 * `corepack pnpm test` 并行跑各包的测试，它们原来共用一个测试库：一个包在数全库会话、另一个包同时在建会话，
 * 计数就偏一个，红点每次落在不同的包（「15 !== 14」）。每个包换成自己的一份库（从测试库克隆），
 * 并行照旧，互不看见对方的数据。
 *
 * 克隆库名同样以 `_test` 结尾：`resolveTestDatabaseUrl()` 的安全闸对它照样成立。
 */

/** PG 标识符上限 63 字节；库名全是 ASCII，按字符截即可。 */
const MAX_IDENTIFIER = 63;

/** 包名 → 克隆库名：`carlife_test` + `@cabinhug/gateway` → `carlife_gateway_test`。 */
export function testCloneDatabaseName(baseDatabase: string, packageName: string): string {
  const stem = baseDatabase.endsWith(REQUIRED_SUFFIX) ? baseDatabase.slice(0, -REQUIRED_SUFFIX.length) : baseDatabase;
  const slug = packageName.replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const room = MAX_IDENTIFIER - stem.length - REQUIRED_SUFFIX.length - 1;
  return `${stem}_${slug.slice(0, Math.max(room, 1))}${REQUIRED_SUFFIX}`;
}

/** 基于已校验的测试库地址，换成某个包的克隆库地址（主机、账号、参数不变）。 */
export function testCloneUrl(baseUrl: string, packageName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${testCloneDatabaseName(databaseNameOf(url), packageName)}`;
  return url.toString();
}
