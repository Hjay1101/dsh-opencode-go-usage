// dsh-opencode-go-usage —— Typert 主机清单（手写）。
//
// typert-loader 通过 package.json 的 exports["./typert"] 引入本文件，
// 注册到 ctx.typert.local；Host 网关据此在严格模式下认领并分发
// "opencodeUsage/usage" 端点：入参为一个可选的 force 布尔
// （true = 绕过缓存强制刷新），出参用 zod schema 校验，
// 校验通过的结果才会跨 RPC 传给浏览器端。

import { z } from "zod";

const windowSchema = z.object({
  status: z.string().nullable(),
  percent: z.number().nullable(),
  resetsAt: z.string().nullable(),
});

const modelEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  monthlyUsd: z.number().nullable(),
  free: z.boolean().optional(),
});
const modelsResultSchema = z.object({
  configured: z.boolean(),
  reason: z.string().nullable(),
  error: z.string().nullable(),
  models: z.array(modelEntrySchema).nullable(),
});

const resultSchema = z.object({
  configured: z.boolean(),
  reason: z.string().nullable(),
  error: z.string().nullable(),
  usage: z
    .object({
      rolling: windowSchema.nullable(),
      weekly: windowSchema.nullable(),
      monthly: windowSchema.nullable(),
    })
    .nullable(),
});

export const TYPERT = {
  package: "dsh-opencode-go-usage",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-opencode-go-usage#opencodeUsage/usage",
      service: "opencodeUsage",
      namespace: "opencodeUsage",
      method: "usage",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "force",
          wire: "force",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-opencode-go-usage#usage:force",
            schema: z.boolean(),
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-opencode-go-usage#OpencodeGoUsageResult",
        schema: resultSchema,
      },
    },
    {
      id: "dsh-opencode-go-usage#opencodeUsage/models",
      service: "opencodeUsage",
      namespace: "opencodeUsage",
      method: "models",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-opencode-go-usage#OpencodeGoModelsResult",
        schema: modelsResultSchema,
      },
    },
  ],
  model: { services: [], events: [], objects: [] },
};
