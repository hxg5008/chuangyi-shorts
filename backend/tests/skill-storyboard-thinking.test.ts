import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-skill-thinking-'))
const backend = fileURLToPath(new URL('../', import.meta.url))
after(async () => {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('huobao-skill-thinking-'))
  await fs.rm(directory, { recursive: true, force: true })
})

// Each scenario starts a fresh module graph so the actual factories read their
// startup environment, while all database/workspace writes stay in this fixture.
const script = String.raw`
  import assert from 'node:assert/strict';
  const logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); }; console.error = () => {};
  const captures = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(['https://offline-thinking.example.test/v1/chat/completions', 'https://api.openai.com/v1/chat/completions'].includes(String(url)));
    assert.equal(init.method, 'POST');
    const body = JSON.parse(String(init.body));
    assert.equal(body.stream, true);
    captures.push(body);
    const event = (delta, finish = null) => 'data: ' + JSON.stringify({ id: 'offline-thinking', object: 'chat.completion.chunk', created: 0, model: 'offline',
      choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(event({ role: 'assistant', content: '' })));
      controller.enqueue(encoder.encode(event({ content: '{"output":"offline ' })));
      setImmediate(() => {
        controller.enqueue(encoder.encode(event({ content: 'complete"}' })));
        controller.enqueue(encoder.encode(event({}, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const { db, schema } = await import('./src/db/index.ts');
  const fixtureOwner=await (await import('./tests/helpers/platform-fixture.ts')).platformFixtureOwner();
  db.insert(schema.dramas).values({ id:1,ownerUserId:fixtureOwner.id,title:'Disposable thinking project',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z' }).run();
  db.insert(schema.episodes).values({ id:1,dramaId:1,episodeNumber:1,title:'Disposable thinking episode',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z' }).run();
  const { buildAgentRequestContext } = await import('./src/agents/context.ts');
  const { createSkillStoryboardAgent, createStoryboardSegmentAgent } = await import('./src/agents/index.ts');
  const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'text', provider: 'openai', name: 'Offline thinking fixture',
    baseUrl: 'https://offline-thinking.example.test/v1', apiKey: 'offline-placeholder', model: '["offline"]',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }).returning().get();
  const requestContext = buildAgentRequestContext({ episodeId: 1, dramaId: 1, textConfigId: config.id, language: 'zh' });
  const responseSchema = { type: 'object', properties: { output: { type: 'string' } }, required: ['output'], additionalProperties: false };
  const instructions = 'Original full skill instructions. Keep the complete natural-language result. Tail sentinel.';
  const user = JSON.stringify({ task: 'Offline single-turn probe', keep: 'original words' });
  for (const type of ['storyboard_breaker', 'prompt_generator']) {
    const agent = createSkillStoryboardAgent(type, instructions, responseSchema);
    const stream = await agent.stream([{ role: 'user', content: user }], { requestContext, maxRetries: 0, modelSettings: { maxRetries: 0 }, stopWhen: ({ steps }) => steps.length >= 1 });
    const full = await stream.getFullOutput();
    assert.equal(full.error, undefined);
    assert.deepEqual(JSON.parse(full.text), { output: 'offline complete' });
    const body = captures.at(-1);
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages.map(message => message.role), ['system', 'user']);
    assert.equal(body.messages[0].content, instructions);
    assert.equal(body.messages[1].content, user);
    assert.equal(Object.hasOwn(body, 'tools'), false);
    assert.equal(Object.hasOwn(body, 'tool_choice'), false);
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'skill_storyboard', schema: responseSchema, strict: true } });
    assert.equal(body.max_tokens, 16384);
  }
  const legacy = createStoryboardSegmentAgent({}, 'Legacy single-call fixture.', true);
  const legacyStream = await legacy.stream([{ role: 'user', content: user }], { requestContext, maxRetries: 0, modelSettings: { maxRetries: 0 }, stopWhen: ({ steps }) => steps.length >= 1 });
  const legacyFull = await legacyStream.getFullOutput();
  assert.equal(legacyFull.error, undefined);
  assert.deepEqual(JSON.parse(legacyFull.text), { output: 'offline complete' });
  assert.equal(captures.length, 3, 'One streaming request per factory; no fallback or resubmission');
  if (process.env.OFFLINE_EXECUTION_SCENARIO === 'execution') {
    const invoke = async (agent, context = requestContext) => {
      const output = await agent.stream([{ role: 'user', content: user }], { requestContext: context, maxRetries: 0, stopWhen: ({ steps }) => steps.length >= 1 });
      const result = await output.getFullOutput();
      assert.equal(result.error, undefined);
      assert.deepEqual(JSON.parse(result.text), { output: 'offline complete' });
      const body = captures.at(-1);
      assert.ok(body.messages.some(message => message.content === instructions));
      assert.ok(body.messages.some(message => message.content === user));
      assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'skill_storyboard', schema: responseSchema, strict: true } });
      assert.equal(Object.hasOwn(body, 'tools'), false);
      return body;
    };
    const execution = { thinking: 'disabled', maxOutputTokens: 32768, profile: 'direct' };
    const direct = createSkillStoryboardAgent('storyboard_breaker', instructions, responseSchema, execution);
    execution.thinking = 'default'; execution.maxOutputTokens = 1;
    const directBody = await invoke(direct);
    assert.deepEqual(directBody.thinking, { type: 'disabled' });
    assert.equal(directBody.max_tokens, 32768);
    const defaultBody = await invoke(createSkillStoryboardAgent('prompt_generator', instructions, responseSchema, { thinking: 'default', maxOutputTokens: 24576, profile: 'recovery' }));
    for (const key of ['thinking', 'enable_thinking', 'reasoning_effort']) assert.equal(Object.hasOwn(defaultBody, key), false);
    assert.equal(defaultBody.max_tokens, 24576);
    const reset = await invoke(createSkillStoryboardAgent('storyboard_breaker', instructions, responseSchema));
    assert.equal(reset.max_tokens, 16384);
    assert.equal(Object.hasOwn(reset, 'thinking'), process.env.AI_DISABLE_THINKING === 'true');
    const official = db.insert(schema.aiServiceConfigs).values({ serviceType: 'text', provider: 'openai', name: 'Offline official fixture',
      baseUrl: 'https://api.openai.com/v1', apiKey: 'offline-placeholder', model: '["gpt-5"]',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }).returning().get();
    const officialContext = buildAgentRequestContext({ episodeId: 1, dramaId: 1, textConfigId: official.id, language: 'zh' });
    const officialBody = await invoke(createSkillStoryboardAgent('storyboard_breaker', instructions, responseSchema, { thinking: 'disabled', maxOutputTokens: 32768, profile: 'recovery' }), officialContext);
    assert.equal(officialBody.max_completion_tokens, 32768, 'The installed OpenAI SDK chooses its documented reasoning-model token field');
    for (const key of ['thinking', 'enable_thinking', 'reasoning_effort', 'max_tokens']) assert.equal(Object.hasOwn(officialBody, key), false);
    const deepSeekConfig = db.insert(schema.aiServiceConfigs).values({ serviceType: 'text', provider: 'openai', name: 'Offline registered DeepSeek fixture',
      baseUrl: 'https://offline-thinking.example.test/v1', apiKey: 'offline-placeholder', model: '["deepseek-v4.1-flash"]',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }).returning().get();
    const deepSeekContext = buildAgentRequestContext({ episodeId: 1, dramaId: 1, textConfigId: deepSeekConfig.id, modelOverride: 'deepseek-v4.1-flash', language: 'zh' });
    const low = await invoke(createSkillStoryboardAgent('storyboard_breaker', instructions, responseSchema, { thinking: 'low', maxOutputTokens: 32768, profile: 'standard' }), deepSeekContext);
    assert.deepEqual(low.thinking, { type: 'enabled' });
    assert.equal(low.reasoning_effort, 'low');
    assert.equal(low.max_tokens, 32768);
    for (const key of ['enable_thinking', 'thinking_budget', 'reasoning_budget']) assert.equal(Object.hasOwn(low, key), false);
    const afterLow = await invoke(createSkillStoryboardAgent('storyboard_breaker', instructions, responseSchema), deepSeekContext);
    assert.equal(afterLow.max_tokens, 16384);
    assert.equal(Object.hasOwn(afterLow, 'thinking'), process.env.AI_DISABLE_THINKING === 'true');
    const otherLow = await invoke(createSkillStoryboardAgent('storyboard_breaker', instructions, responseSchema, { thinking: 'low', maxOutputTokens: 32768 }), requestContext);
    assert.equal(Object.hasOwn(otherLow, 'thinking'), process.env.AI_DISABLE_THINKING === 'true', 'Low leaves unrelated models on their existing environment policy');
    assert.notEqual(otherLow.reasoning_effort, 'low');
    const officialLow = await invoke(createSkillStoryboardAgent('storyboard_breaker', instructions, responseSchema, { thinking: 'low', maxOutputTokens: 32768 }), officialContext);
    assert.equal(officialLow.max_completion_tokens, 32768);
    for (const key of ['thinking', 'enable_thinking', 'reasoning_effort', 'max_tokens']) assert.equal(Object.hasOwn(officialLow, key), false);
    const beforeInvalid = captures.length;
    for (const budget of [NaN, Infinity, -1, 0, 1023, 65537, 32768.5]) {
      assert.throws(() => createSkillStoryboardAgent('storyboard_breaker', instructions, responseSchema, { maxOutputTokens: budget }), RangeError);
    }
    assert.throws(() => createSkillStoryboardAgent('storyboard_breaker', instructions, responseSchema, { thinking: 'unexpected' }), TypeError);
    assert.throws(() => createSkillStoryboardAgent('storyboard_breaker', instructions, responseSchema, { profile: 'unexpected' }), TypeError);
    assert.equal(captures.length, beforeInvalid, 'Invalid execution settings are rejected before any provider request');
    assert.ok(logs.some(line => line.includes('skill-request-execution') && line.includes('profile=direct') && line.includes('thinkingPolicy=disabled') && line.includes('maxOutputTokens=32768')));
    assert.ok(logs.some(line => line.includes('skill-request-execution') && line.includes('thinkingPolicy=low') && line.includes('maxOutputTokens=32768')));
    assert.equal(captures.length, 11);
  }
  db.$client.close();
  process.stdout.write(JSON.stringify(captures.map(body => ({
    hasThinking: Object.hasOwn(body, 'thinking'), thinking: body.thinking,
    hasEnableThinking: Object.hasOwn(body, 'enable_thinking'), enable_thinking: body.enable_thinking,
    hasReasoningEffort: Object.hasOwn(body, 'reasoning_effort'), reasoning_effort: body.reasoning_effort,
    max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens,
    response_format: body.response_format,
  }))));
`

function capture(setting?: string, executionScenario?: string) {
  const name = `${setting ?? 'unset'}-${executionScenario || 'legacy'}`, scenario = path.join(directory, name)
  const env = { ...process.env, SQLITE_PATH: path.join(scenario, 'fixture.sqlite3'), HUOBAO_DATA_DIR: scenario,
    STORAGE_PATH: path.join(scenario, 'static'), WORKSPACE_PATH: path.join(scenario, 'workspace'), MYSQL_AUTO_IMPORT: 'false',
    DOTENV_CONFIG_PATH: path.join(scenario, 'absent.env'), DOTENV_CONFIG_QUIET: 'true', AI_MAX_TOKENS: '16384' }
  delete env.AI_DISABLE_THINKING
  delete env.AI_THINKING_OFF_PATCH
  delete env.OFFLINE_EXECUTION_SCENARIO
  if (setting !== undefined) env.AI_DISABLE_THINKING = setting
  if (executionScenario) env.OFFLINE_EXECUTION_SCENARIO = executionScenario
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    cwd: backend, env, input: script, encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout)
  return JSON.parse(result.stdout)
}
function noThinkingOverride(body: any) {
  assert.equal(body.hasThinking, false)
  assert.equal(body.hasEnableThinking, false)
  assert.equal(body.hasReasoningEffort, false)
}
function thinkingDisabled(body: any) {
  assert.deepEqual(body.thinking, { type: 'disabled' })
  assert.equal(body.enable_thinking, false)
  assert.equal(body.reasoning_effort, 'none')
}

test('actual skill factories preserve model thinking defaults while legacy factories keep their old unset-environment patch', () => {
  const [breakdown, prompt, legacy] = capture()
  noThinkingOverride(breakdown)
  noThinkingOverride(prompt)
  thinkingDisabled(legacy)
})

test('explicit AI_DISABLE_THINKING=true is respected by both skill factories and legacy factories', () => {
  for (const body of capture('true')) thinkingDisabled(body)
})

test('explicit AI_DISABLE_THINKING=false leaves both skill and legacy model thinking defaults intact', () => {
  for (const body of capture('false')) noThinkingOverride(body)
})

test('per-request skill execution changes only its own budget and thinking policy, uses SDK fields on official endpoints, and rejects invalid budgets', () => {
  for (const setting of ['true', 'false']) {
    const bodies = capture(setting, 'execution')
    thinkingDisabled(bodies[3])
    assert.equal(bodies[3].max_tokens, 32768)
    noThinkingOverride(bodies[4])
    assert.equal(bodies[4].max_tokens, 24576)
    assert.equal(bodies[5].max_tokens, 16384)
    noThinkingOverride(bodies[6])
    assert.equal(bodies[6].max_completion_tokens, 32768)
    assert.deepEqual(bodies[7].thinking, { type: 'enabled' })
    assert.equal(bodies[7].reasoning_effort, 'low')
    assert.equal(bodies[7].hasEnableThinking, false)
    assert.equal(bodies[8].max_tokens, 16384)
    if (setting === 'true') thinkingDisabled(bodies[8])
    else noThinkingOverride(bodies[8])
    assert.notEqual(bodies[9].reasoning_effort, 'low')
    noThinkingOverride(bodies[10])
  }
})
