const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { OAuth2Client } = require('google-auth-library');
const { Resend } = require('resend');
const db = require('../db');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const resend = new Resend(process.env.RESEND_API_KEY);

// ── EMAIL TEMPLATE HELPER ──
function emailTemplate(content) {
  return `
    <div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff">
      <!-- Header -->
      <div style="background:#0F1C17;padding:24px 32px;border-radius:12px 12px 0 0">
        <span style="font-family:Georgia,serif;font-size:24px;color:#fff;font-weight:700;letter-spacing:-.5px">Man<span style="color:#F5C842">bi</span></span>
        <div style="font-size:11px;color:rgba(255,255,255,.4);margin-top:2px;letter-spacing:.5px;text-transform:uppercase">Zero-interest crowdfunded loans</div>
      </div>
      <!-- Body -->
      <div style="padding:32px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px">
        ${content}
        <hr style="border:none;border-top:1px solid #F3F4F6;margin:28px 0 20px">
        <p style="font-size:11px;color:#9CA3AF;line-height:1.6;margin:0">
          © 2026 SC Manbi LBG · Zero-interest crowdfunded loans for Ghana's entrepreneurs<br>
          Questions? <a href="mailto:manbiinitiative@gmail.com" style="color:#1A9070;text-decoration:none">manbiinitiative@gmail.com</a>
        </p>
      </div>
    </div>
  `;
}

// ── SEND WELCOME EMAIL ──
async function sendWelcomeEmail(fname, email) {
  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: `Welcome to Manbi, ${fname}! 🌱`,
      html: emailTemplate(`
        <h2 style="font-size:24px;color:#0F1C17;margin:0 0 8px;font-family:Georgia,serif">Welcome to Manbi, ${fname}! 🌱</h2>
        <p style="font-size:15px;color:#4B5563;line-height:1.7;margin:0 0 20px">
          You've just joined a growing community of people who believe that access to fair, interest-free capital can change lives in Ghana.
        </p>
        <div style="background:#F0FDF4;border:1px solid #D1FAE5;border-radius:12px;padding:20px;margin-bottom:24px">
          <div style="font-size:13px;font-weight:600;color:#065F46;margin-bottom:12px;text-transform:uppercase;letter-spacing:.4px">What you can do on Manbi</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            <div style="font-size:14px;color:#374151">🌾 <strong>Browse entrepreneurs</strong> — real people, real businesses, real dreams</div>
            <div style="font-size:14px;color:#374151">💰 <strong>Fund from GHS 10</strong> — because 10 cedis can change a life</div>
            <div style="font-size:14px;color:#374151">🔄 <strong>Get repaid</strong> — and choose to reinvest, cash out, or donate</div>
          </div>
        </div>
        <a href="${process.env.FRONTEND_URL}/manbi-dashboard.html" style="display:inline-block;background:#1A9070;color:#fff;text-decoration:none;padding:14px 28px;border-radius:50px;font-size:15px;font-weight:500;margin-bottom:20px">
          Start lending →
        </a>
        <p style="font-size:13px;color:#6B7280;line-height:1.6;margin:0">
          If you have any questions, just reply to this email — we're a small team and we read every message.
        </p>
      `)
    });
  } catch (err) {
    console.error('Welcome email error:', err.message);
    // Don't fail registration if email fails
  }
}

// ── VALIDATION RULES ──
const registerRules = [
  body('fname').trim().notEmpty().withMessage('First name is required').isLength({ max: 100 }),
  body('lname').trim().notEmpty().withMessage('Last name is required').isLength({ max: 100 }),
body('email').trim().isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('momo').optional().trim().isLength({ max: 20 }).withMessage('Momo number is invalid'),
  body('network').optional().custom((value) => {
    if (!value) return true;
    const validNetworks = ['mtn', 'telecel', 'airteltigo'];
    if (!validNetworks.includes(value.toLowerCase())) {
      throw new Error('Please select a valid network provider');
    }
return true;
  })
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

    // Send welcome email (non-blocking)
    sendWelcomeEmail(lender.fname, lender.email);

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

    if (lender.suspended) {
      return res.status(403).json({ error: 'Your account has been suspended. Please contact manbiinitiative@gmail.com.' });
    }

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
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ error: 'Missing Google credential.' });
  }

  try {
    // Verify the token directly with Google — never trust raw fields from the client
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    const google_id = payload.sub;
    const email = (payload.email || '').toLowerCase();
    const fname = payload.given_name || 'Friend';
    const lname = payload.family_name || '';
    const avatar = '🌱';

    if (!email) {
      return res.status(400).json({ error: 'Your Google account has no email address.' });
    }

    // Check if user already exists
    const existing = await db.query(
      'SELECT * FROM lenders WHERE email = $1',
      [email]
    );

    let lender;
    let isNew = false;

    if (existing.rows.length > 0) {
      // Existing user — log them in
      lender = existing.rows[0];

      // Link their Google account if not already linked
      if (!lender.google_id) {
        await db.query('UPDATE lenders SET google_id = $1 WHERE id = $2', [google_id, lender.id]);
        lender.google_id = google_id;
      }
    } else {
      // New user — create account
      isNew = true;
      const result = await db.query(
        `INSERT INTO lenders (fname, lname, email, password_hash, momo_number, momo_network, level, vault_balance, avatar, google_id)
         VALUES ($1, $2, $3, $4, NULL, 'MTN', 'Seed Sower', 0, $5, $6)
         RETURNING id, fname, lname, email, momo_number, momo_network, level, vault_balance, avatar, squad, created_at, google_id`,
        [fname, lname, email, 'GOOGLE_AUTH', avatar, google_id]
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

    // Send welcome email for new signups only (non-blocking)
    if (isNew) sendWelcomeEmail(lender.fname, lender.email);

  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(500).json({ error: 'Google sign-in failed. Please try again.' });
  }
});

// ── FORGOT PASSWORD ──
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    const result = await db.query(
      'SELECT id, fname FROM lenders WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    // Always return success to prevent user enumeration
    if (result.rows.length === 0) {
      return res.json({ message: 'If an account exists with this email, a reset link has been sent.' });
    }

    const lender = result.rows[0];

    // Generate secure random token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Invalidate any existing reset tokens for this user
    await db.query(
      'UPDATE password_resets SET used = TRUE WHERE lender_id = $1 AND used = FALSE',
      [lender.id]
    );

    // Store new token
    await db.query(
      'INSERT INTO password_resets (lender_id, token, expires_at) VALUES ($1, $2, $3)',
      [lender.id, token, expiresAt]
    );

    const resetUrl = `${process.env.FRONTEND_URL}/manbi-reset-password.html?token=${token}`;

    // Send email via Resend
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: email,
      subject: 'Reset your Manbi password',
      html: `
        <div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff">
          <div style="margin-bottom:24px">
            <span style="font-family:Georgia,serif;font-size:22px;color:#0F1C17;font-weight:700">Man<span style="color:#F5C842">bi</span></span>
          </div>
          <h2 style="font-size:22px;color:#0F1C17;margin-bottom:8px">Reset your password</h2>
          <p style="font-size:15px;color:rgba(15,28,23,.65);line-height:1.6;margin-bottom:24px">
            Hi ${lender.fname}, we received a request to reset your Manbi password. Click the button below to set a new one.
          </p>
          <a href="${resetUrl}" style="display:inline-block;background:#1A9070;color:#fff;text-decoration:none;padding:14px 28px;border-radius:50px;font-size:15px;font-weight:500;margin-bottom:24px">
            Reset my password →
          </a>
          <p style="font-size:13px;color:rgba(15,28,23,.45);line-height:1.6">
            This link expires in <strong>1 hour</strong>. If you didn't request a password reset, you can safely ignore this email — your account is secure.
          </p>
          <hr style="border:none;border-top:1px solid rgba(15,28,23,.08);margin:24px 0">
          <p style="font-size:12px;color:rgba(15,28,23,.35)">© 2026 SC Manbi LBG · Zero-interest crowdfunded loans for Ghana's entrepreneurs</p>
        </div>
      `
    });

    res.json({ message: 'If an account exists with this email, a reset link has been sent.' });

  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
  }
});

// ── RESET PASSWORD ──
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    // Find valid unused token
    const result = await db.query(
      `SELECT pr.*, l.email, l.fname FROM password_resets pr
       JOIN lenders l ON l.id = pr.lender_id
       WHERE pr.token = $1 AND pr.used = FALSE AND pr.expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    const reset = result.rows[0];

    // Hash new password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Update password
    await db.query(
      'UPDATE lenders SET password_hash = $1 WHERE id = $2',
      [hashedPassword, reset.lender_id]
    );

    // Mark token as used
    await db.query(
      'UPDATE password_resets SET used = TRUE WHERE id = $1',
      [reset.id]
    );

    // Send confirmation email
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: reset.email,
      subject: 'Your Manbi password has been changed',
      html: `
        <div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff">
          <div style="margin-bottom:24px">
            <span style="font-family:Georgia,serif;font-size:22px;color:#0F1C17;font-weight:700">Man<span style="color:#F5C842">bi</span></span>
          </div>
          <h2 style="font-size:22px;color:#0F1C17;margin-bottom:8px">Password changed ✓</h2>
          <p style="font-size:15px;color:rgba(15,28,23,.65);line-height:1.6;margin-bottom:24px">
            Hi ${reset.fname}, your Manbi password has been successfully changed. You can now log in with your new password.
          </p>
          <p style="font-size:13px;color:rgba(15,28,23,.45);line-height:1.6">
            If you did not make this change, please contact us immediately at <a href="mailto:manbiinitiative@gmail.com" style="color:#1A9070">manbiinitiative@gmail.com</a>.
          </p>
          <hr style="border:none;border-top:1px solid rgba(15,28,23,.08);margin:24px 0">
          <p style="font-size:12px;color:rgba(15,28,23,.35)">© 2026 SC Manbi LBG · Zero-interest crowdfunded loans for Ghana's entrepreneurs</p>
        </div>
      `
    });

    res.json({ message: 'Password reset successfully. You can now log in.' });

  } catch (err) {
    console.error('Reset password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password. Please try again.' });
  }
});

router.emailTemplate = emailTemplate;
router.resend = resend;
module.exports = router;
