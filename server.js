#!/usr/bin/env node
// OpenClaw ↔ Claude Code CLI Proxy
// Exposes OpenAI-compatible /v1/chat/completions endpoint
// Routes through: claude -p --dangerously-skip-permissions

const express = require('express');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3456', 10);
const API_KEY = process.env.API_KEY || '';
const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '240000', 10);

let activeRequests = 0;

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function auth(req, res, next) {
  if (!API_KEY) return next(); // no key configured = open
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (token !== API_KEY) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
  }
  next();
}

// ---------------------------------------------------------------------------
// Convert OpenAI messages array to a single prompt string
// ---------------------------------------------------------------------------
function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const parts = [];
  for (const msg of messages) {
    const role = msg.role || 'user';
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(c => c.text || '').join('\n')
        : String(msg.content || '');

    if (role === 'system') {
      parts.push(`[System Instructions]\n${content}\n[End System Instructions]`);
    } else if (role === 'assistant') {
      // Handle assistant messages that previously made tool calls
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        const tcDesc = msg.tool_calls.map(tc => {
          let args = tc.function?.arguments || '{}';
          try { args = JSON.stringify(JSON.parse(args), null, 2); } catch (_) {}
          return `<tool_call>\n{"name": "${tc.function?.name}", "arguments": ${args}}\n</tool_call>`;
        }).join('\n');
        parts.push(`[Previous Assistant Response]\n${content || ''}${tcDesc ? '\n' + tcDesc : ''}`);
      } else {
        parts.push(`[Previous Assistant Response]\n${content}`);
      }
    } else if (role === 'tool') {
      // Tool execution results from OpenClaw
      const name = msg.name || msg.tool_call_id || 'unknown';
      parts.push(`[Tool Result: ${name}]\n${content}`);
    } else {
      parts.push(content);
    }
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Spawn Claude Code CLI and collect output
// When useTools=true, enables native Claude Code tool execution
// (--dangerously-skip-permissions --max-turns 10 --output-format json)
// ---------------------------------------------------------------------------
const DEFAULT_MAX_TOOL_TURNS = parseInt(process.env.MAX_TOOL_TURNS || '10', 10);

function callClaude(prompt, systemPrompt, useTools = false, maxTurns = DEFAULT_MAX_TOOL_TURNS) {
  return new Promise((resolve, reject) => {
    // Always use --verbose --output-format stream-json to parse assistant
    // messages directly, because CLI v2.1.83 has a bug where --print returns
    // empty "result" even when the model actually responded.
    const args = ['--print', '--verbose', '--output-format', 'stream-json'];

    if (useTools) {
      args.push('--dangerously-skip-permissions');
      args.push('--max-turns', String(maxTurns));
    }

    const SYS_PROMPT_ARG_LIMIT = 100_000;
    let stdinInput = '';

    if (systemPrompt && systemPrompt.length <= SYS_PROMPT_ARG_LIMIT) {
      args.push('--system-prompt', systemPrompt);
    } else if (systemPrompt) {
      stdinInput += `[System Instructions]\n${systemPrompt}\n[End System Instructions]\n\n`;
    }

    stdinInput += prompt;

    const proc = spawn(CLAUDE_CLI, args, {
      cwd: process.env.HOME || '/home/ubuntu',
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: REQUEST_TIMEOUT,
    });

    proc.stdin.write(stdinInput);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      // Parse stream-json: extract text from assistant messages
      const textParts = [];
      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                textParts.push(block.text);
              }
            }
          }
          // Also check the result field as fallback
          if (event.type === 'result' && event.result) {
            textParts.push(event.result);
          }
        } catch (_) {
          // Skip non-JSON lines
        }
      }

      const result = textParts.join('').trim();
      resolve(result);
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });

    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      reject(new Error('Claude CLI timed out'));
    }, REQUEST_TIMEOUT + 5000);
  });
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions
// ---------------------------------------------------------------------------
app.post('/v1/chat/completions', auth, async (req, res) => {
  const { messages, model, stream, max_tokens, tools } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: { message: 'messages array is required', type: 'invalid_request_error' }
    });
  }

  if (activeRequests >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: { message: 'Too many concurrent requests, please retry later', type: 'rate_limit_error' }
    });
  }

  activeRequests++;
  const requestId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // Extract system prompt separately for --system-prompt flag
  let systemPrompt = '';
  const nonSystemMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
    } else {
      nonSystemMessages.push(msg);
    }
  }

  // When OpenClaw sends tools, we enable Claude Code's native tool execution.
  // Claude Code handles Read/Write/Bash internally and returns the final result.
  const hasTools = tools && Array.isArray(tools) && tools.length > 0;
  const prompt = messagesToPrompt(nonSystemMessages);

  console.log(`[${new Date().toISOString()}] Request ${requestId} | model=${model || 'default'} | stream=${!!stream} | native_tools=${hasTools} | messages=${messages.length} | prompt_len=${prompt.length}`);

  try {
    // -----------------------------------------------------------------------
    // Call Claude CLI. When tools are requested, Claude Code uses its own
    // built-in tools (Read, Write, Bash, etc.) via --dangerously-skip-permissions.
    // It executes tools internally and returns the final text result.
    // -----------------------------------------------------------------------
    const requestMaxTurns = req.body.max_turns ?? DEFAULT_MAX_TOOL_TURNS;
    const result = await callClaude(prompt, systemPrompt || undefined, hasTools, requestMaxTurns);

    // -----------------------------------------------------------------------
    // If client requested streaming, simulate SSE from the complete response
    // -----------------------------------------------------------------------
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Request-Id', requestId);

      const chunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: model || 'claude-opus-4-6',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: result },
          finish_reason: null,
        }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);

      const doneChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: model || 'claude-opus-4-6',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();

      activeRequests--;
      console.log(`[${new Date().toISOString()}] Completed ${requestId} (simulated stream) | response_len=${result.length}`);
      return;
    }
    activeRequests--;

    const response = {
      id: requestId,
      object: 'chat.completion',
      created,
      model: model || 'claude-opus-4-6',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(result.length / 4),
        total_tokens: Math.ceil((prompt.length + result.length) / 4),
      },
    };

    console.log(`[${new Date().toISOString()}] Completed ${requestId} | response_len=${result.length}`);
    res.json(response);

  } catch (err) {
    activeRequests--;
    console.error(`[${new Date().toISOString()}] Error ${requestId}:`, err.message);
    res.status(500).json({
      error: { message: err.message, type: 'server_error' }
    });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/models — Fake model list for compatibility
// ---------------------------------------------------------------------------
app.get('/v1/models', auth, (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'claude-opus-4-6',
        object: 'model',
        created: 1700000000,
        owned_by: 'anthropic',
      },
      {
        id: 'claude-sonnet-4-5-20250929',
        object: 'model',
        created: 1700000000,
        owned_by: 'anthropic',
      },
      {
        id: 'claude-haiku-4-5-20251001',
        object: 'model',
        created: 1700000000,
        owned_by: 'anthropic',
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', active_requests: activeRequests, max_concurrent: MAX_CONCURRENT });
});

// ---------------------------------------------------------------------------
// Readiness check — actually spawns CLI to verify it can respond
// ---------------------------------------------------------------------------
let lastReadyCheck = { ok: false, ts: 0, error: '' };
const READY_CACHE_MS = 60_000; // cache result for 60s

app.get('/health/ready', async (req, res) => {
  const now = Date.now();
  if (now - lastReadyCheck.ts < READY_CACHE_MS) {
    const status = lastReadyCheck.ok ? 200 : 503;
    return res.status(status).json({
      status: lastReadyCheck.ok ? 'ready' : 'not_ready',
      cached: true,
      error: lastReadyCheck.error || undefined,
      active_requests: activeRequests,
    });
  }

  try {
    const result = await callClaude('回覆 ok');
    const ok = result && result.length > 0;
    lastReadyCheck = { ok, ts: now, error: ok ? '' : 'empty response' };
    const status = ok ? 200 : 503;
    res.status(status).json({
      status: ok ? 'ready' : 'not_ready',
      cached: false,
      active_requests: activeRequests,
    });
  } catch (err) {
    lastReadyCheck = { ok: false, ts: now, error: err.message };
    res.status(503).json({
      status: 'not_ready',
      cached: false,
      error: err.message,
      active_requests: activeRequests,
    });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  OpenClaw ↔ Claude Code Proxy               ║
║  Port: ${String(PORT).padEnd(38)}║
║  Auth: ${API_KEY ? 'Enabled'.padEnd(38) : 'Disabled (set API_KEY)'.padEnd(38)}║
║  Max concurrent: ${String(MAX_CONCURRENT).padEnd(27)}║
║  CLI: ${CLAUDE_CLI.padEnd(39)}║
╠══════════════════════════════════════════════╣
║  POST /v1/chat/completions                   ║
║  GET  /v1/models                             ║
║  GET  /health                                ║
╚══════════════════════════════════════════════╝
  `);
});
