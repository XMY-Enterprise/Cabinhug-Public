/**
 * Compose 数据卷的物理名（ACR-051）。
 *
 * 卷名由 `name:` 钉在物理名上，与 Compose 项目名无关。改动它会挂上一个新的空卷，
 * 原数据不再可见。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

const INFRA = new URL("../", import.meta.url);

/** 卷键 → 物理名。新增卷在这里登记；已有的一行都不许改。 */
const PINNED: Record<string, Record<string, string>> = {
  "docker-compose.yml": {
    "carlife-pg-data": "carlife-pg-data",
    "carlife-minio-data": "carlife-minio-data",
    "carlife-redis-data": "carlife-redis-data",
    "carlife-qdrant-data": "carlife-qdrant-data",
    "carlife-whisper-models": "carlife-whisper-models",
  },
  "docker-compose.stack.yml": { "mock-cabin-var": "carlife-mock-cabin-var" },
  "compose/ollama.yml": { "carlife-ollama-data": "carlife_carlife-ollama-data" },
};

function composeFiles(): string[] {
  const nested = readdirSync(new URL("compose/", INFRA)).filter((f) => f.endsWith(".yml"));
  return ["docker-compose.yml", "docker-compose.stack.yml", ...nested.map((f) => `compose/${f}`)];
}

function volumesOf(file: string): Record<string, string | null> {
  const doc = parse(readFileSync(new URL(file, INFRA), "utf8")) as {
    volumes?: Record<string, { name?: string } | null>;
  };
  return Object.fromEntries(Object.entries(doc.volumes ?? {}).map(([key, v]) => [key, v?.name ?? null]));
}

describe("[M110-10] Compose 数据卷钉住改名前的物理名", () => {
  for (const file of composeFiles()) {
    it(`${file}：每个卷都钉了物理名且与登记一致`, () => {
      const volumes = volumesOf(file);
      assert.deepEqual(volumes, PINNED[file] ?? {}, "卷名变了等于换了一个空卷");
    });
  }
});
