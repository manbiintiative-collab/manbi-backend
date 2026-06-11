const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

// ── REGISTER ──
router.post('/register', async (req, res) => {
  const { fname, lname, email, momo, network, password } = req.body;

  if (!fname || !lname || !email || !password) {
    return res.status(400).json({ error: 'Please fill in all required fields.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    // Check if email already exists
    const existing = await db.query('SELECT id FROM lenders WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create lender
    const result = await db.query(
      `INSERT INTO lenders (fname, lname, email, momo_number, momo_network, password_hash, level, vault_balance)
       VALUES ($1, $2, $3, $4, $5, $6, 'Seed Sower', 0)
       RETURNING id, fname, lname, email, momo_number, momo_network, level, vault_balance, avatar, squad, created_at`,
      [fname, lname, email.toLowerCase(), momo || null, network || 'MTN', hashedPassword]
    );

    const lender = result.rows[0];

    // Generate token
    const token = jwt.sign(
      { id: lender.id, email: lender.email, role: 'lender' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({ token, user: lender });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ── LOGIN ──
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const result = await db.query(
      'SELECT * FROM lenders WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const lender = result.rows[0];
    const validPassword = await bcrypt.compare(password, lender.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const token = jwt.sign(
      { id: lender.id, email: lender.email, role: 'lender' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Remove password from response
    delete lender.password_hash;

    res.json({ token, user: lender });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
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
      'SELECT id, fname, lname, email, momo_number, momo_network, level, vault_balance, avatar, squad, created_at FROM lenders WHERE id = $1',
      [decoded.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(403).json({ error: 'Invalid session.' });
  }
});

module.exports = router;
