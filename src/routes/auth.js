const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../db');

// ── VALIDATION RULES ──
const registerRules = [
  body('fname').trim().notEmpty().withMessage('First name is required').isLength({ max: 100 }),
  body('lname').trim().notEmpty().withMessage('Last name is required').isLength({ max: 100 }),
  body('email').trim().isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('momo').optional().trim().isLength({ max: 20 }),
  body('network').optional().isIn(['MTN', 'Telecel', 'AirtelTigo']),
];

const loginRules = [
  body('email').trim().isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

// ── REGISTER ──
router.post('/register', registerRules, async (req, res) => {
  // Validate inputs
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const { fname, lname, email, momo, network, password } = req.body;

  try {
    // Check if email already exists
    const existing = await db.query(
      'SELECT id FROM lenders WHERE email = $1',
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password with cost factor 12
    const hashedPassword = await bcrypt.hash(password, 12);

    const result = await db.query(
      `INSERT INTO lenders (fname, lname, email, momo_number, momo_network, password_hash, level, vault_balance)
       VALUES ($1, $2, $3, $4, $5, $6, 'Seed Sower', 0)
       RETURNING id, fname, lname, email, momo_number, momo_network, level, vault_balance, avatar, squad, created_at`,
      [fname, lname, email, momo || null, network || 'MTN', hashedPassword]
    );

    const lender = result.rows[0];

    const token = jwt.sign(
      { id: lender.id, email: lender.email, role: 'lender' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    const refreshToken = jwt.sign(
      { id: lender.id, type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    );

    res.status(201).json({ token, refreshToken, user: lender });

  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ── LOGIN ──
router.post('/login', loginRules, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const { email, password } = req.body;

  try {
    const result = await db.query(
      'SELECT * FROM lenders WHERE email = $1',
      [email]
    );

    // Use same error message for both "not found" and "wrong password"
    // to prevent user enumeration attacks
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const lender = result.rows[0];
    const validPassword = await bcrypt.compare(password, lender.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const token = jwt.sign(
      { id: lender.id, email: lender.email, role: lender.role || 'lender' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    const refreshToken = jwt.sign(
      { id: lender.id, type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    );

    // Remove sensitive fields before sending
    delete lender.password_hash;

    res.json({ token, refreshToken, user: lender });

  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── REFRESH TOKEN ──
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'Refresh token required.' });

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    if (decoded.type !== 'refresh') return res.status(403).json({ error: 'Invalid token type.' });

    const result = await db.query(
      'SELECT id, email, role FROM lenders WHERE id = $1',
      [decoded.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found.' });

    const lender = result.rows[0];
    const newToken = jwt.sign(
      { id: lender.id, email: lender.email, role: lender.role || 'lender' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ token: newToken });
  } catch (err) {
    res.status(403).json({ error: 'Invalid or expired refresh token.' });
  }
});

// ── GET CURRENT USER ──
router.get('/me', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await db.query(
      `SELECT id, fname, lname, email, momo_number, momo_network,
              level, vault_balance, avatar, squad, created_at
       FROM lenders WHERE id = $1`,
      [decoded.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(403).json({ error: 'Invalid session.' });
  }
});

// ── GOOGLE OAUTH ──
router.post('/google', async (req, res) => {
  const { google_id, email, fname, lname, avatar } = req.body;

  if (!google_id || !email) {
    return res.status(400).json({ error: 'Invalid Google credentials.' });
  }

  try {
    // Check if user already exists
    const existing = await db.query(
      'SELECT * FROM lenders WHERE email = $1',
      [email.toLowerCase()]
    );

    let lender;
    let isNew = false;

    if (existing.rows.length > 0) {
      // Existing user — log them in
      lender = existing.rows[0];
    } else {
      // New user — create account
      isNew = true;
      const result = await db.query(
        `INSERT INTO lenders (fname, lname, email, password_hash, momo_number, momo_network, level, vault_balance, avatar, google_id)
         VALUES ($1, $2, $3, $4, NULL, 'MTN', 'Seed Sower', 0, $5, $6)
         RETURNING id, fname, lname, email, momo_number, level, vault_balance, avatar, squad, created_at`,
        [fname, lname || '', email.toLowerCase(), 'GOOGLE_AUTH', avatar || '🌱', google_id]
      );
      lender = result.rows[0];
    }

    const token = jwt.sign(
      { id: lender.id, email: lender.email, role: lender.role || 'lender' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    const refreshToken = jwt.sign(
      { id: lender.id, type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '90d' }
    );

    delete lender.password_hash;
    res.json({ token, refreshToken, user: lender, isNew });

  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(500).json({ error: 'Google sign-in failed. Please try again.' });
  }
});

module.exports = router;
