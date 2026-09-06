// Mock swallowing upstream (Node) for the real-framework integration test.
// Serves the live-captured llama.cpp b8461 swallow (the XML envelope in
// reasoning_content with no tool_calls) for tool requests.
import http from 'node:http';

const SWALLOW = {
  id: 'chatcmpl-mock-swallow',
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: 'llamacpp-mock',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '',
        reasoning_content:
          '\nI found the top-level files and directories. Now I need to read the package.json to see what scripts are defined there.\n\n<tool_call>\n<function=read_file>\n<parameter=path>\npackage.json\n</parameter>\n</function>\n</tool_call>\n',
      },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 45, total_tokens: 145 },
};

const PLAIN = {
  id: 'chatcmpl-mock-plain',
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: 'llamacpp-mock',
  choices: [
    { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello! I am the mock upstream.' } },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
};

const STREAM_CHUNKS = [
  '\nI need to read package.json.',
  '<tool_call>',
  '<function=read_file>',
  '<parameter=path>',
  'package.json',
  '</parameter>',
  '</function>',
  '</tool_call>',
];

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad json' }));
      return;
    }
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of STREAM_CHUNKS) {
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-mock-stream',
            object: 'chat.completion.chunk',
            model: 'llamacpp-mock',
            choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }],
          })}\n\n`
        );
      }
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-mock-stream',
          object: 'chat.completion.chunk',
          model: 'llamacpp-mock',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0 && payload.tool_choice !== 'none';
    if (hasTools) {
      // The conversation carries a previous tool result with the scripts =>
      // this is the follow-up turn after the recovered read_file ran: reply
      // with a plain answer so the agent loop can finish.
      const history = JSON.stringify(payload.messages ?? []);
      if (history.includes('"build"') || history.includes('vitest')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ...PLAIN,
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content:
                    'The scripts defined in package.json are: "build": "tsc" and "test": "vitest".',
                },
              },
            ],
          })
        );
        return;
      }
      // Otherwise: swallow the tool call (XML envelope in reasoning, no tool_calls).
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SWALLOW));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(PLAIN));
  });
});

const port = Number(process.argv[2] ?? 18080);
server.listen(port, '127.0.0.1', () => console.log(`mock swallowing upstream on http://127.0.0.1:${port}`));
