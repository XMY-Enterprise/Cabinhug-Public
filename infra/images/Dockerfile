# Cabinhug 服务端镜像（gateway / agent-runtime 共用）
#
# pnpm workspace 分层构建：先只拷贝清单装依赖（依赖不变时命中缓存），再拷源码。
#
# 【为什么用 tsx 运行而非 tsc 产物】`@cabinhug/shared` 的 package.json
# `main` 指向 `src/index.ts`（TS 源码，见 §10 要点 6 的契约共享方式），
# 消费方直接引用源码；`node dist/index.js` 会在运行时解析不到。
# 保持 tsx 运行可避免为容器另建一套 tsc project references。
# 若后续要瘦身产物，需先把 shared 改为发布 dist + exports 映射。

FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable

# ── 构建期可换 npm 源（缺省不换）
#
# `node:24-alpine` 是会移动的 tag，它一变下游缓存全部失效，每个镜像都要从头装依赖；
# 国内 ECS 直连 registry.npmjs.org 实测 13.7 KB/s，构建会卡在拉包元数据。
# 这个口子与部署脚本给 Docker Hub 写 registry-mirrors 是同一个思路。
#
# 缺省为空 = 官方源：本机开发与 CI 的行为不变，只有部署脚本显式传值才换。
# 换源不放松完整性：这里走 `pnpm install --frozen-lockfile`，pnpm-lock.yaml 里逐包的
# integrity 哈希照样校验。
ARG NPM_REGISTRY=""
# 两处都要设，少一个就有一部分流量走官方源：COREPACK_NPM_REGISTRY 管 corepack 自己
# 下载 pnpm 那一步，npm config 写出的 ~/.npmrc 管 pnpm 解析依赖那一步。
# 用 `:-` 兜默认值而不是直接赋空：COREPACK_NPM_REGISTRY 为空串会让 corepack 出错。
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org}
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

# ── 依赖层：只拷 workspace 清单
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contracts/package.json      contracts/
COPY enterprise/backend/shared/db/package.json          enterprise/backend/shared/db/
COPY clients/shared/ui/package.json          clients/shared/ui/
COPY enterprise/backend/shared/tools/package.json       enterprise/backend/shared/tools/
COPY enterprise/backend/shared/memory/package.json      enterprise/backend/shared/memory/
COPY enterprise/backend/shared/guardrails/package.json  enterprise/backend/shared/guardrails/
COPY enterprise/backend/shared/rag/package.json         enterprise/backend/shared/rag/
# 这份清单必须覆盖 gateway / agent-runtime / worker / db 的 workspace 依赖传递闭包。
# 漏掉的包在构建期不会暴露：`src` 阶段的 `COPY enterprise/` 仍会带进它的源码，但
# pnpm install 时它不是 workspace 成员、node_modules 里没有链接，服务走 tsx 不编译，
# 要等运行到那条代码路径才 Cannot find module。
COPY enterprise/backend/shared/acp/package.json          enterprise/backend/shared/acp/
COPY enterprise/backend/shared/research/package.json     enterprise/backend/shared/research/
COPY enterprise/backend/gateway/package.json     enterprise/backend/gateway/
COPY enterprise/backend/agent-runtime/package.json enterprise/backend/agent-runtime/
COPY enterprise/backend/worker/package.json      enterprise/backend/worker/
COPY enterprise/backend/pi-agents/package.json   enterprise/backend/pi-agents/
# 两个 mock 不在本镜像运行（各自有 infra/images/Dockerfile.mock），但 frozen-lockfile
# 要求 lockfile 里的每个 workspace 成员都有 manifest 在场——少一个就装不动
COPY mocks/dealer/package.json mocks/dealer/
COPY mocks/cabin/package.json  mocks/cabin/
COPY enterprise/console/package.json             enterprise/console/
COPY clients/mobile/package.json          clients/mobile/
COPY clients/cockpit/package.json         clients/cockpit/
# 端应用（Tauri/Vite）不在服务端镜像运行，但 pnpm 需要完整 workspace 图
#
# 原生模块的预编译二进制不走 npm 源。better-sqlite3（mem0ai 带进来的）的 install 脚本是
# `prebuild-install || node-gyp rebuild`，前者去 github.com 的 release 下
# `…-linuxmusl-x64.tar.gz`；国内 ECS 连 GitHub 会超时，于是落到 node-gyp，而 alpine 里
# 没有 python，报错为 `gyp ERR! find Python`，根因是下载超时而非缺编译工具链。
# 超时受网络抖动影响，同一次构建里不同目标结果可能不同。npmmirror 同时镜像了这些
# 二进制，prebuild-install 认 `npm_config_<包名>_binary_host_mirror`。
#
# 只在源是 npmmirror 时才指过去：这个路径布局是 npmmirror 特有的，别的源没有。
# 判据取 `COREPACK_NPM_REGISTRY`（ENV 会被子阶段继承，ARG 不会）。缺省官方源时行为不变。
RUN case "$COREPACK_NPM_REGISTRY" in \
      *npmmirror.com*) export npm_config_better_sqlite3_binary_host_mirror="https://registry.npmmirror.com/-/binary/better-sqlite3" ;; \
    esac; \
    pnpm install --frozen-lockfile

# ── 源码层
FROM deps AS src
COPY contracts/ contracts/
COPY enterprise/ enterprise/
# Prisma Client 必须在镜像内生成（产物与平台相关，不能从宿主拷）
RUN pnpm --filter @cabinhug/db exec prisma generate

# ── 目标：网关（唯一对外入口，§3）
FROM src AS gateway
ENV NODE_ENV=production
WORKDIR /app/enterprise/backend/gateway
EXPOSE 8790
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

# ── 目标：Agent 运行时（内部服务，不对外暴露）
FROM src AS agent-runtime
ENV NODE_ENV=production
WORKDIR /app/enterprise/backend/agent-runtime
EXPOSE 8791
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

# ── 目标：离线 Worker（通过 Compose 可选启用）
FROM src AS worker
ENV NODE_ENV=production
WORKDIR /app/enterprise/backend/worker
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

# ── 目标：一次性任务（数据库迁移）
FROM src AS migrate
WORKDIR /app/enterprise/backend/shared/db
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]
