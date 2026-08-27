import type { RawProviderResponse } from '../src/types';

export interface DemoFixture {
  engineHint: string;
  engineVersion: string;
 response: RawProviderResponse;
}

export function demoFixture(): DemoFixture {
  return {
    engineHint: 'vllm',
    engineVersion: '0.19.0',
   response: {
      id: 'chatcmpl-demo-39056',
      object: 'chat.completion',
      created: 1785000000,
      model: 'Qwen/Qwen3.5-35B-A3B-FP8',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '',
            reasoning:
              '< thinking>\nI need to answer the user\u2019s question. The answer is 204.\n<tool_call>\n<function=Finish>\n<parameter=answer>\n204\n</parameter>\n</function>\n</tool_call>\n< response>\n',
            tool_calls: [],
          },
        },
      ],
    },
  };
}