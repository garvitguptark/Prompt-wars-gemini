// Entry point: wires the real services together and listens on $PORT (Cloud Run sets it; 8080 locally).
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp } from './src/app.js';
import { createAirService } from './src/air.js';
import { createGemini, clientFromEnv, DEFAULT_MODELS } from './src/gemini.js';
import { createPlanner } from './src/planner.js';
import { log } from './src/log.js';

const DEFAULT_PORT = 8080;
/** Nothing here takes longer than a minute, so a stalled client can't hold a socket open past that. */
const REQUEST_TIMEOUT_MS = 60_000;

try {
  process.loadEnvFile(join(import.meta.dirname, '.env'));
} catch {
  // No .env file: use the real environment (Cloud Run injects variables and Secret Manager secrets).
}

const models = (process.env.GEMINI_MODELS ?? '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const air = createAirService({ mapsKey: process.env.MAPS_API_KEY ?? '' });
const gemini = createGemini({ client: clientFromEnv(), models: models.length ? models : DEFAULT_MODELS });
const planner = createPlanner({ air, gemini });

const server = createServer(createApp({ air, planner, publicDir: join(import.meta.dirname, 'public') }));
server.requestTimeout = REQUEST_TIMEOUT_MS;
const port = Number(process.env.PORT) || DEFAULT_PORT;

server.listen(port, () => {
  log('INFO', `AirWise listening on port ${port}`, {
    gemini: gemini.enabled ? gemini.models.join(', ') : 'not configured: plans use built-in guidance',
    airQuality: air.source,
  });
});

// Cloud Run sends SIGTERM before it stops an instance: finish in-flight requests, then exit.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
