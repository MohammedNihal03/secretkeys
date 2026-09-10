import { createOpenAICompatibleAdapter } from './openai-compatible';

/**
 * Qwen adapter (Alibaba Cloud Model Studio / DashScope).
 *
 * Docs: https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope
 *
 * DashScope offers an OpenAI-compatible surface at `/compatible-mode/v1`.
 *
 * REGION: the default below is the international endpoint. DashScope is
 * region-partitioned and a key issued in one region is not accepted in
 * another -- mainland China uses `dashscope.aliyuncs.com`, and there are
 * separate US and workspace-scoped hosts. Set `QWEN_BASE_URL` to override.
 *
 * No usage or cost endpoint is exposed through the compatible surface;
 * consumption is visible in the Model Studio console.
 */
const DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

export const qwenAdapter = createOpenAICompatibleAdapter({
  type: 'qwen',
  displayName: 'Qwen',
  baseUrl: process.env.QWEN_BASE_URL?.trim() || DEFAULT_BASE_URL,
  capabilities: {
    usage: 'none',
    cost: 'none',
    limits: 'none',
    meters: ['requests', 'tokens'],
    notes:
      'No usage, cost or quota endpoint on the OpenAI-compatible surface. Region-partitioned: set QWEN_BASE_URL if your key was issued outside the international endpoint.',
  },
  noUsageDetail:
    'The DashScope OpenAI-compatible API exposes no usage or cost endpoint. Consumption is visible only in the Alibaba Cloud Model Studio console.',
});
