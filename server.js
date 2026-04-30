require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const { testConnection, query: dbQuery } = require('./lib/db');

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

const app = express();

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
app.use('/api/scenarios',  require('./routes/scenarios'));
app.use('/api/scenarios',  require('./routes/ai-summary'));

// ─── Health check ─────────────────────────────────────────────────────────────
// Railway treats non-2xx as failed deploys. Always return 200 once HTTP is up;
// use `db` in the body for ops (connected vs unreachable).
app.get('/health', async (req, res) => {
  let db = 'unreachable';
  try {
    await dbQuery('SELECT 1');
    db = 'connected';
  } catch {
    // still 200 — avoids health-check timeouts when DB is briefly slow after boot
  }
  res.status(200).json({
    status: db === 'connected' ? 'ok' : 'degraded',
    db,
    agents: {
      doc_agent:     !!process.env.DOC_AGENT_URL,
      summary_agent: !!process.env.SUMMARY_AGENT_URL,
    },
    timestamp: new Date().toISOString(),
  });
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
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Listen immediately so platform health checks do not time out while the DB warms up.
app.listen(PORT, HOST, () => {
  console.log(
    `✓ PA Plan API listening on http://${HOST}:${PORT} [${process.env.NODE_ENV || 'development'}]`
  );
  testConnection().catch((err) => {
    console.error(`⚠ PostgreSQL not reachable after boot: ${err.message}`);
  });
});
