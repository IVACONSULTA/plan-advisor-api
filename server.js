require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const app = express();

// ─── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Global rate limiter — tightened limits applied per AI endpoint in the routes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
app.use(globalLimiter);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/countries',   require('./routes/countries'));
app.use('/api/providers',   require('./routes/providers'));
app.use('/api/admin',       require('./routes/users'));
app.use('/api/admin',       require('./routes/profiles'));
app.use('/api/admin',       require('./routes/documents'));
app.use('/api/admin',       require('./routes/rules'));
app.use('/api/admin',       require('./routes/plans'));
app.use('/api/calculator',  require('./routes/calculator'));
app.use('/api/scenarios',   require('./routes/scenarios'));
app.use('/api/scenarios',   require('./routes/ai-summary'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
app.listen(PORT, () => {
  console.log(`PA Plan API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});
