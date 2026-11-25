// The Gemini client: one place that talks to the model, with a fallback chain of models, a time budget and
// structured output. What to ask lives in prompts.js; the shape of a plan and its clean-up live in plan-schema.js.
/** @import { GeminiClient, GeminiOptions, GeminiService, GenerateRequest } from './types.js' */
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { PLAN_SYSTEM, ASK_SYSTEM, planPrompt, askPrompt } from './prompts.js';
import { PLAN_SCHEMA, sanitizePlan, cleanAnswer } from './plan-schema.js';
import { ServiceUnavailable } from './errors.js';
import { log as defaultLog } from './log.js';
import { MINUTE_MS, HOUR_MS } from './util.js';

// Tried in order, fastest first: a family is waiting on the answer. A model can be overloaded (429/503),
// slow (504/timeout) or closed to a project (404). A model that just failed moves to the back of the line for a
// while, so the next request starts with one that is answering; it is still tried, because overloads pass quickly.
export const DEFAULT_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'];

/** How long a failed model waits at the back of the line: missing models for hours, busy ones for minutes. */
const COOLDOWN_MS = { missing: 6 * HOUR_MS, busy: 2 * MINUTE_MS };
/** HTTP statuses that say "try another model", rather than "this request is wrong". */
const RETRYABLE = new Set([404, 408, 429, 500, 502, 503, 504]);
/** Starting a call with less time than this left would only time out. */
const MIN_ATTEMPT_MS = 2_000;

/**
 * Builds the client from the environment: Vertex AI (Cloud Run service account, no key) or a Gemini API key.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {GoogleGenAI | null}  null when there are no credentials, which turns Gemini off
 */
export function clientFromEnv(env = process.env) {
  if (env.GOOGLE_GENAI_USE_VERTEXAI === 'true') {
    return new GoogleGenAI({
      vertexai: true,
      project: env.GOOGLE_CLOUD_PROJECT,
      location: env.GOOGLE_CLOUD_LOCATION || 'global',
    });
  }
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  return apiKey ? new GoogleGenAI({ apiKey }) : null;
}

/**
 * An older model that refuses the thinking setting answers fine without it.
 * @param {any} err
 * @param {boolean} sentThinking
 */
const rejectsThinking = (err, sentThinking) => err.status === 400 && sentThinking && /thinking/i.test(err.message);

/**
 * Overloads, timeouts and missing models are worth handing to the next model; anything else is our request's fault.
 * @param {any} err
 */
const worthNextModel = (err) => !err.status || RETRYABLE.has(err.status);

/**
 * Calls the models in order until one answers, within a total time budget. A model that just failed moves to the
 * back of the line for a while; a model that rejects the thinking setting is retried once without it.
 * @param {GeminiOptions & { client: GeminiClient }} options
 */
function modelChain({ client, models, timeoutMs, budgetMs, log, now }) {
  /** @type {Set<string>} models known to reject the thinking setting */
  const noThinkingLevel = new Set();
  /** @type {Map<string, number>} model -> when it may lead the line again */
  const coolingUntil = new Map();
  /** @param {string} model */
  const isCooling = (model) => (coolingUntil.get(model) ?? 0) > now();

  /**
   * One model, one call. A model that rejects the thinking setting is remembered and asked again without it.
   * @param {string} model
   * @param {GenerateRequest} request
   * @param {number} timeout
   * @returns {Promise<{ text?: string }>}
   */
  async function callModel(model, { contents, config, thinkingLevel }, timeout) {
    const sendThinking = !noThinkingLevel.has(model);
    const thinking = sendThinking ? { thinkingConfig: { thinkingLevel } } : {};
    try {
      return await client.models.generateContent({
        model,
        contents,
        config: { ...config, ...thinking, httpOptions: { timeout } },
      });
    } catch (err) {
      if (!rejectsThinking(err, sendThinking)) throw err;
      noThinkingLevel.add(model);
      return callModel(model, { contents, config, thinkingLevel }, timeout);
    }
  }

  /**
   * @param {GenerateRequest} request
   * @returns {Promise<{ text: string, model: string }>}
   */
  return async function generate(request) {
    const deadline = now() + budgetMs;
    const order = [...models.filter((model) => !isCooling(model)), ...models.filter(isCooling)];
    let lastError;
    for (const model of order) {
      const remaining = deadline - now();
      if (remaining < MIN_ATTEMPT_MS) break;
      try {
        const response = await callModel(model, request, Math.min(timeoutMs, remaining));
        return { text: response.text ?? '', model };
      } catch (err) {
        if (!worthNextModel(err)) throw err;
        const { status, name } = /** @type {{ status?: number, name?: string }} */ (err);
        log('WARNING', 'Gemini model unavailable, trying the next one', { model, status: status ?? name });
        coolingUntil.set(model, now() + (status === 404 ? COOLDOWN_MS.missing : COOLDOWN_MS.busy));
        lastError = err;
      }
    }
    throw lastError ?? new Error('Gemini did not answer in time');
  };
}

/**
 * The Gemini service the planner uses. With no client it reports itself disabled and every call fails with 503.
 * @param {Partial<GeminiOptions> & { client: GeminiClient | null }} options
 * @returns {GeminiService}
 */
export function createGemini({
  client,
  models = DEFAULT_MODELS,
  timeoutMs = 30_000,
  budgetMs = 50_000,
  log = defaultLog,
  now = Date.now,
}) {
  const generate = client
    ? modelChain({ client, models, timeoutMs, budgetMs, log, now })
    : () => Promise.reject(new ServiceUnavailable('Gemini is not configured'));
  return {
    enabled: Boolean(client),
    models,
    async plan(context) {
      const config = {
        systemInstruction: PLAN_SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: PLAN_SCHEMA,
        temperature: 0.5,
      };
      // The facts are computed in code, so a long JSON reply needs little reasoning: minimal thinking keeps it fast.
      const request = { contents: planPrompt(context), config, thinkingLevel: ThinkingLevel.MINIMAL };
      const { text, model } = await generate(request);
      return { plan: sanitizePlan(JSON.parse(text)), model };
    },
    async ask(context, question) {
      const config = { systemInstruction: ASK_SYSTEM, temperature: 0.4 };
      const request = { contents: askPrompt(context, question), config, thinkingLevel: ThinkingLevel.LOW };
      const { text, model } = await generate(request);
      const answer = cleanAnswer(text);
      if (!answer) throw new Error('Gemini returned an empty answer');
      return { answer, model };
    },
  };
}
