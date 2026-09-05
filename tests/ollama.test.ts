import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { OLLAMA_DEFAULT_URL, ollamaProvider, providerFor, useOllamaUrl } from '../server/providers.js';
import { apiKeyStatus, getApiKey, needsNoKey } from '../server/settings.js';
import { post } from './request.js';

/**
 * A model running on the reader's own machine.
 *
 * "Is it possible for the tool to use Ollama and local LLMs for the AI
 * functionality?"
 *
 * Ollama is not installed on the machine this was written on, so it is tested
 * against a server that speaks its protocol rather than against a promise that
 * it would have worked. That is the part worth holding anyway: what the app
 * puts on the wire, and what it does with what comes back.
 *
 * The one place it must differ from OpenAI is the structured-output request.
 * OpenAI's `strict` flag is a contract Ollama does not implement, and sending
 * a flag a server does not know fails the whole call — where leaving it off
 * merely makes the schema advisory, which everything downstream already
 * survives because it treats a model's answer as untrusted.
 */

interface Seen {
  path: string;
  body: Record<string, unknown>;
  auth: string | undefined;
}

const seen: Seen[] = [];
let server: Server;
let base: string;
let models: string[] = ['llama3.1:8b', 'qwen2.5:14b'];
let reply = '{"masthead":"The Local Ledger"}';

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.get('/v1/models', (req, res) => {
    seen.push({ path: req.path, body: {}, auth: req.headers.authorization });
    res.json({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'library' })) });
  });
  app.post('/v1/chat/completions', (req, res) => {
    seen.push({ path: req.path, body: req.body as Record<string, unknown>, auth: req.headers.authorization });
    res.json({
      id: 'chatcmpl-local',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
    });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
  server.close();
  useOllamaUrl(() => OLLAMA_DEFAULT_URL);
});

describe('talking to a local model', () => {
  it('posts the prompt to the address it was given', async () => {
    seen.length = 0;
    const text = await ollamaProvider(base).complete({
      key: '', model: 'llama3.1:8b', system: 'You are the sports desk.',
      messages: [{ role: 'user', content: 'Write the issue.' }], maxTokens: 1000,
    });
    expect(text).toBe(reply);
    const call = seen.find((s) => s.path === '/v1/chat/completions')!;
    expect(call.body.model).toBe('llama3.1:8b');
    expect(call.body.messages).toEqual([
      { role: 'system', content: 'You are the sports desk.' },
      { role: 'user', content: 'Write the issue.' },
    ]);
  });

  /*
   * The flag that would have broken it. Ollama honours a JSON schema and
   * rejects the strict contract OpenAI wraps around one.
   */
  it('asks for the schema without the strict flag OpenAI needs', async () => {
    seen.length = 0;
    await ollamaProvider(base).complete({
      key: '', model: 'llama3.1:8b', system: 's', messages: [{ role: 'user', content: 'u' }],
      maxTokens: 100,
      schema: { type: 'object', properties: { masthead: { type: 'string' } } },
    });
    const format = seen.find((s) => s.path === '/v1/chat/completions')!.body.response_format as {
      type: string; json_schema: Record<string, unknown>;
    };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.schema).toEqual({
      type: 'object', properties: { masthead: { type: 'string' } },
    });
    expect(format.json_schema).not.toHaveProperty('strict');
  });

  /*
   * Ollama documents `max_tokens`; `max_completion_tokens`, which the OpenAI
   * path uses, is not on its list. A field a server does not know is a coin
   * flip between being ignored and failing the call.
   */
  it('caps the answer with the field Ollama documents', async () => {
    seen.length = 0;
    await ollamaProvider(base).complete({
      key: '', model: 'llama3.1:8b', system: 's',
      messages: [{ role: 'user', content: 'u' }], maxTokens: 4096,
    });
    const body = seen.find((s) => s.path === '/v1/chat/completions')!.body;
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('sends no credential of the reader’s to a local server', async () => {
    seen.length = 0;
    await ollamaProvider(base).complete({
      key: 'sk-ant-NOT-A-REAL-KEY-for-this-test', model: 'llama3.1:8b', system: 's',
      messages: [{ role: 'user', content: 'u' }], maxTokens: 10,
    });
    for (const call of seen) {
      expect(call.auth ?? '').not.toContain('sk-ant');
    }
  });

  it('lists the models that are actually installed', async () => {
    const found = await ollamaProvider(base).listModels('');
    expect(found.map((m) => m.id)).toEqual(['llama3.1:8b', 'qwen2.5:14b']);
  });

  /*
   * There is no key to check, so the check that matters is whether anything is
   * listening and whether it has a model. Both are things a reader can act on,
   * and "no models" is the likelier of the two on a fresh install.
   */
  it('accepts a server that has a model pulled', async () => {
    await expect(ollamaProvider(base).validateKey('')).resolves.toBeUndefined();
  });

  it('says so when the server is running with nothing pulled', async () => {
    models = [];
    await expect(ollamaProvider(base).validateKey('')).rejects.toThrow(/ollama pull/);
    models = ['llama3.1:8b'];
  });

  it('fails plainly when nothing is listening', async () => {
    await expect(
      ollamaProvider('http://127.0.0.1:1/v1').listModels('')
    ).rejects.toThrow();
  });

  it('reads its address from the setting rather than a constant', async () => {
    seen.length = 0;
    useOllamaUrl(() => base);
    await providerFor('ollama').complete({
      key: '', model: 'llama3.1:8b', system: 's',
      messages: [{ role: 'user', content: 'u' }], maxTokens: 10,
    });
    expect(seen.some((s) => s.path === '/v1/chat/completions')).toBe(true);
  });

  it('defaults to where Ollama actually listens', () => {
    expect(OLLAMA_DEFAULT_URL).toBe('http://localhost:11434/v1');
  });
});


/**
 * Every AI feature checks for a key before it will do anything, which is right
 * for a service that bills for the call and wrong for one running on your own
 * machine. Eight call sites make that check and none of them needed to learn
 * about a fifth provider.
 */
describe('a provider with nobody to bill', () => {
  it('needs no key, where the paid services do', () => {
    expect(needsNoKey('ollama')).toBe(true);
    for (const paid of ['anthropic', 'openai', 'gemini', 'opencode'] as const) {
      expect(needsNoKey(paid)).toBe(false);
    }
  });

  it('satisfies the key check every AI feature makes', () => {
    // Not a credential: it exists so the gates upstream pass and the SDK,
    // which refuses to be built without one, has something to hold
    expect(getApiKey('ollama')).toBeTruthy();
  });

  it('reports itself as configured, so Settings has nothing to nag about', () => {
    const status = apiKeyStatus('ollama');
    expect(status.configured).toBe(true);
    expect(status.hint).toBeNull();
  });

  it('does not report a paid provider as configured just because this one is', () => {
    expect(apiKeyStatus('gemini').configured).toBe(getApiKey('gemini') !== null);
  });
});


/**
 * Found by running the whole path against a server that logs what it is asked.
 *
 * The app posted an empty model and the stub answered anyway. The setting had
 * never saved: model ids were validated against a shape that allowed letters,
 * digits, dots and hyphens, and every Ollama id in the world carries a colon.
 * The save returned 200, the picker sprang back to empty, and the request went
 * out with no model in it.
 */
describe('saving the name of a local model', () => {
  const save = (model: string) => post('/api/settings', { provider: 'ollama', model });

  it('accepts the colon every Ollama id carries', async () => {
    const r = await save('llama3.1:8b');
    expect(r.settings.models.ollama).toBe('llama3.1:8b');
  });

  it('accepts a pulled Hugging Face model, slashes and all', async () => {
    const r = await save('hf.co/bartowski/Qwen2.5-14B-GGUF');
    expect(r.settings.models.ollama).toBe('hf.co/bartowski/Qwen2.5-14B-GGUF');
  });

  it('still refuses something that is not a model id', async () => {
    const before = (await save('llama3.1:8b')).settings.models.ollama;
    const r = await save('rm -rf ~; echo');
    expect(r.settings.models.ollama).toBe(before);
  });

  it('says what to do when no model has been chosen', async () => {
    await expect(
      ollamaProvider(base).complete({
        key: '', model: '  ', system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10,
      })
    ).rejects.toThrow(/Pick one in Settings/);
  });
});
