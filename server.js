require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const { testConnection, query: dbQuery } = require('./lib/db');
const {
  validateApiKeyConfiguredAtStartup,
  requireApiKey,
} = require('./lib/api-key');

// ─── Env validation ──────────────────────────────────────────────────────────
// Fail fast for truly required variables; warn for optional ones.
const REQUIRED_VARS = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const OPTIONAL_VARS = ['DOC_AGENT_URL', 'SUMMARY_AGENT_URL', 'AGENT_API_KEY'];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length) {
    console.error(`✗ Missing required environment variables: ${missing.join(', ')}`);
    console.error('  Set them in the Railway service Variables tab and redeploy.');
    process.exit(1);
  }
  OPTIONAL_VARS.forEach((v) => {
    if (!process.env[v]) {
      console.warn(`⚠ Optional env var not set: ${v} (AI agent features will be unavailable)`);
    }
  });
}

validateEnv();
validateApiKeyConfiguredAtStartup();

const app = express();

// One reverse proxy (Railway, etc.) sets X-Forwarded-For — required for express-rate-limit + correct req.ip.
app.set('trust proxy', Number(process.env.TRUST_PROXY_COUNT) || 1);

// Platform liveness (Railway / load balancers): no DB, no middleware — must respond fast.
const HOST = process.env.HOST || '0.0.0.0';

app.get('/live', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ─── Security middleware ─────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Global rate limiter — AI endpoints apply tighter limits on top of this
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
app.use(globalLimiter);

// Shared secret for clients / Postman / BFF — skipped for GET /health and GET /live only.
app.use(requireApiKey);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/countries',  require('./routes/countries'));
app.use('/api/providers',  require('./routes/providers'));
app.use('/api/admin',      require('./routes/admin-catalog'));
app.use('/api/admin',      require('./routes/users'));
app.use('/api',            require('./routes/user-session'));
app.use('/api/admin',      require('./routes/profiles'));
app.use('/api/admin',      require('./routes/documents'));
app.use('/api/admin',      require('./routes/rules'));
app.use('/api/admin',      require('./routes/plans'));
app.use('/api/calculator', require('./routes/calculator'));
// Register summary routes before generic `GET /:id` so `POST .../generate-summary` always hits this router.
app.use('/api/scenarios',  require('./routes/ai-summary'));
app.use('/api/scenarios',  require('./routes/scenarios'));

// ─── Health check ─────────────────────────────────────────────────────────────
// Always HTTP 200 once the process is listening (matches Railway + our deploy docs).
// Use JSON `db` / `status` to tell if Postgres is actually reachable.
app.get('/health', async (_req, res) => {
  try {
    await dbQuery('SELECT 1');
    res.status(200).json({
      status: 'ok',
      db: 'connected',
      agents: {
        doc_agent:     !!process.env.DOC_AGENT_URL,
        summary_agent: !!process.env.SUMMARY_AGENT_URL,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (_err) {
    res.status(200).json({
      status: 'degraded',
      db: 'unreachable',
      agents: {
        doc_agent:     !!process.env.DOC_AGENT_URL,
        summary_agent: !!process.env.SUMMARY_AGENT_URL,
      },
      timestamp: new Date().toISOString(),
    });
  }
});

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error.',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
// Listen immediately (like ExpressApi). Do not await DB first — Railway health probes
// need a bound port even if Postgres is still warming up or briefly unreachable.
const PORT = process.env.PORT || 3000;

app.listen(PORT, HOST, () => {
  console.log(
    `✓ PA Plan API listening on http://${HOST}:${PORT} [${process.env.NODE_ENV || 'development'}]`,
  );
  testConnection().catch((err) => {
    console.error('⚠ PostgreSQL not reachable at startup — API is up; DB-dependent routes may fail:', err.message);
  });
});
