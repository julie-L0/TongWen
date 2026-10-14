import { fail } from '../domain/rules.ts';
import type { ModelClient, ModelMessage } from '../agent/types.ts';
import { ModelResponseError } from '../agent/model-errors.ts';
export class DeepSeekClient implements ModelClient {
  private key: string;
  private model: string;
  private endpoint: string;
  private thinking: boolean;
  private effort: 'low' | 'high' | 'max';
  get configuration() {
    return {
      model: this.model,
      thinking: this.thinking,
      effort: this.thinking ? this.effort : null,
      maxTokens: this.thinking ? 8192 : 4096,
    };
  }
  constructor(config: { key: string; model: string; baseUrl?: string; thinking?: boolean; effort?: string }) {
    if (!config.key.trim() || !config.model.trim())
      fail('MODEL_NOT_CONFIGURED', '请配置账号密钥与可用模型名。', 503);
    const base = new URL(config.baseUrl || 'https://api.deepseek.com');
    if (
      base.protocol !== 'https:' ||
      base.hostname !== 'api.deepseek.com' ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      fail('MODEL_PROVIDER', '当前仅支持官方 DeepSeek 接口。');
    this.key = config.key;
    this.model = ['deepseek-chat', 'deepseek-reasoner'].includes(config.model)
      ? 'deepseek-flash'
      : config.model;
    this.thinking = config.thinking ?? true;
    if (config.effort && !['low', 'high', 'max'].includes(config.effort))
      fail('MODEL_CONFIGURATION', 'DEEPSEEK_REASONING_EFFORT 可选 low/high/max。');
    this.effort = (config.effort || 'low') as 'low' | 'high' | 'max';
    this.endpoint = base.href.replace(/\/$/, '') + '/chat/completions';
  }
  async complete(messages: ModelMessage[], tools: unknown[], signal: AbortSignal) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: this.thinking ? 8192 : 4096,
        thinking: { type: this.thinking ? 'enabled' : 'disabled' },
        ...(this.thinking ? { reasoning_effort: this.effort } : { temperature: 0.1 }),
      }),
      signal,
    });
    if (!response.ok)
      fail(`MODEL_HTTP_${response.status}`, `模型接口返回 ${response.status}，未降级为离线判断。`, 502);
    const data = await response.json(),
      message = data.choices?.[0]?.message;
    const usage = {
      input: Number(data.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(messages).length / 2)),
      output: Number(data.usage?.completion_tokens ?? Math.ceil(JSON.stringify(message || '').length / 2)),
      estimated: !data.usage,
    };
    if (!message || message.role !== 'assistant')
      fail('MODEL_OUTPUT_INVALID', '模型没有返回有效 assistant 消息。', 502);
    if (data.choices[0].finish_reason === 'length')
      throw new ModelResponseError(
        'MODEL_OUTPUT_TRUNCATED',
        '模型响应被截断，未执行其中任何工具调用；请缩小判断批次和文字长度。',
        usage,
      );
    return {
      message: message as ModelMessage,
      model: String(data.model || this.model),
      usage,
    };
  }
}
