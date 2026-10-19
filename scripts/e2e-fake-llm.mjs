/**
 * Minimal OpenAI-compatible fake model used by scripts/e2e.mjs.
 * Turn 1 -> tool_call write. Turn 2 -> echo the last tool result.
 * SCENARIO: cited | uncited | batch
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const LOG = process.env.FAKE_LOG;
function trace(entry) {
  if (!LOG) return;
  try { appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch { /* ignore */ }
}

const PORT = Number(process.env.FAKE_LLM_PORT ?? 18089);
const SCENARIO = process.env.SCENARIO ?? 'cited';
let calls = 0;

const PLAN = {
  cited: { name: 'write', args: { file_path: 'a.txt', content: 'hello' } },
  uncited: { name: 'write', args: { file_path: 'C:/Windows/Temp/evil.txt', content: 'boom' } },
  batch: { name: 'write', args: { file_path: '*.txt', content: 'x' } },
};

/** 'twice'：同一会话内两次同类写，用来验证摊销（第二次不应再问）。 */
const TWICE = [
  { name: 'write', args: { file_path: 'a.txt', content: '1' } },
  { name: 'write', args: { file_path: 'b.txt', content: '2' } },
  null,
];

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function lastToolText(body) {
  const toolMsgs = (body?.messages ?? []).filter((m) => m && m.role === 'tool');
  const last = toolMsgs[toolMsgs.length - 1];
  if (!last) return 'done';
  const raw = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  return String(raw ?? 'done').slice(0, 500);
}

function serve(res, body) {
  const stream = body?.stream !== false;

  // 无工具的请求是会话标题之类的旁路调用：回纯文本，且不消耗脚本步数
  if ((body?.tools ?? []).length === 0) {
    const plain = 'ok';
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fake', object: 'chat.completion', created: 0, model: 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content: plain }, finish_reason: 'stop' }],
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(chunk({ role: 'assistant', content: '' }));
    res.write(chunk({ content: plain }));
    res.write(chunk({}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  calls += 1;
  const callId = `call_${calls}`;
  const step = SCENARIO === 'twice' ? (TWICE[calls - 1] ?? null) : undefined;
  const plan = step ?? PLAN[SCENARIO] ?? PLAN.cited;
  const useTool = SCENARIO === 'twice' ? step !== null : calls % 2 === 1;
  const echo = lastToolText(body);
  trace({ calls, useTool, plan: plan?.name, args: plan?.args, msgs: (body?.messages ?? []).length, tools: (body?.tools ?? []).length });

  if (!stream) {
    const message = useTool
      ? {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name: plan.name, arguments: JSON.stringify(plan.args) } }],
      }
      : { role: 'assistant', content: echo };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-fake', object: 'chat.completion', created: 0, model: 'fake',
      choices: [{ index: 0, message, finish_reason: useTool ? 'tool_calls' : 'stop' }],
    }));
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(chunk({ role: 'assistant', content: '' }));
  if (useTool) {
    res.write(chunk({
      tool_calls: [{
        index: 0, id: callId, type: 'function',
        function: { name: plan.name, arguments: JSON.stringify(plan.args) },
      }],
    }));
    res.write(chunk({}, 'tool_calls'));
  } else {
    res.write(chunk({ content: echo }));
    res.write(chunk({}, 'stop'));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake', object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      serve(res, body);
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.log(`[fake-llm] ${PORT} ${SCENARIO}`));
