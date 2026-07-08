const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// Trust Render's proxy so express-rate-limit can correctly read X-Forwarded-For
// Without this, the rate limiter throws a ValidationError and can crash the process
app.set('trust proxy', 1);

// ── SECURITY ──
app.use(helmet());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://manbi.org',
    'https://www.manbi.org'
  ],
  credentials: true
}));

// ── RATE LIMITING ──
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100
});
app.use('/api/', limiter);

// ── BODY PARSING ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── ROUTES ──
app.use('/api/auth',  require('./src/routes/auth'));
app.use('/api/loans', require('./src/routes/loans'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/payments', require('./src/routes/payments'));

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ status: 'Manbi API is running', version: '1.0.0' });
});

// ── ERROR HANDLER ──
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Manbi API running on port ${PORT}`);
});
