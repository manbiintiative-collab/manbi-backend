const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { emailTemplate, resend } = require('./auth');

// ── GET ALL OPEN LOANS ──
router.get('/', async (req, res) => {
  const { sector, search } = req.query;
  try {
    let query = `
      SELECT l.*, 
        COALESCE(SUM(f.amount), 0) as raised,
        ROUND((COALESCE(SUM(f.amount), 0) / l.goal_amount * 100)::numeric, 0) as pct_funded
      FROM loans l
      LEFT JOIN funding f ON f.loan_id = l.id AND f.status = 'completed'
      WHERE l.status = 'active'
    `;
    const params = [];

    if (sector) {
      params.push(sector);
      query += ` AND l.sector = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (l.entrepreneur_name ILIKE $${params.length} OR l.location ILIKE $${params.length} OR l.purpose ILIKE $${params.length})`;
    }

    query += ' GROUP BY l.id ORDER BY l.created_at DESC';

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (err) {
    console.error('Get loans error:', err);
    res.status(500).json({ error: 'Failed to fetch loans.' });
  }
});

// ── GET SINGLE LOAN ──
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT l.*, 
        COALESCE(SUM(f.amount), 0) as raised,
        ROUND((COALESCE(SUM(f.amount), 0) / l.goal_amount * 100)::numeric, 0) as pct_funded,
        COUNT(DISTINCT f.lender_id) as num_lenders
       FROM loans l
       LEFT JOIN funding f ON f.loan_id = l.id AND f.status = 'completed'
       WHERE l.id = $1
       GROUP BY l.id`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Loan not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch loan.' });
  }
});

// ── FUND A LOAN ──
router.post('/:id/fund', requireAuth, async (req, res) => {
  const { amount, payment_method, phone_number, include_support } = req.body;
  const loanId = req.params.id;
  const lenderId = req.user.id;

  if (!amount || amount < 10) {
    return res.status(400).json({ error: 'Minimum funding amount is GHS 10.' });
  }

  try {
    // Check loan exists and is active
    const loanResult = await db.query(
      `SELECT l.*, COALESCE(SUM(f.amount), 0) as raised
       FROM loans l LEFT JOIN funding f ON f.loan_id = l.id AND f.status = 'completed'
       WHERE l.id = $1 AND l.status = 'active'
       GROUP BY l.id`,
      [loanId]
    );
    if (loanResult.rows.length === 0) {
      return res.status(404).json({ error: 'Loan not found or no longer active.' });
    }

    const loan = loanResult.rows[0];
    const remaining = loan.goal_amount - loan.raised;
    if (amount > remaining) {
      return res.status(400).json({ error: `Maximum you can fund is GHS ${remaining}.` });
    }

    // Support fee
    const supportAmount = include_support ? parseFloat((amount * 0.05).toFixed(2)) : 0;
    const totalDebit = parseFloat(amount) + supportAmount;

    if (payment_method === 'vault') {
      // Vault funding is already-settled money — verify balance and debit it now,
      // and record the funding as completed immediately (no external confirmation needed).
      const lenderResult = await db.query('SELECT vault_balance FROM lenders WHERE id = $1', [lenderId]);
      const vaultBalance = parseFloat(lenderResult.rows[0]?.vault_balance || 0);
      if (totalDebit > vaultBalance) {
        return res.status(400).json({ error: `Insufficient vault balance. Available: GHS ${vaultBalance.toFixed(2)}.` });
      }
      await db.query('UPDATE lenders SET vault_balance = vault_balance - $1 WHERE id = $2', [totalDebit, lenderId]);
    }

    // Record funding — vault is settled instantly, MoMo/other methods stay pending until confirmed elsewhere
    const fundingStatus = payment_method === 'vault' ? 'completed' : 'pending';
    const funding = await db.query(
      `INSERT INTO funding (loan_id, lender_id, amount, support_amount, payment_method, phone_number, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [loanId, lenderId, amount, supportAmount, payment_method, phone_number, fundingStatus]
    );

    // Only mark the loan funded if the ACTUAL completed total (not pending attempts) reaches goal
    const completedResult = await db.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM funding WHERE loan_id = $1 AND status = 'completed'`,
      [loanId]
    );
    const newRaised = parseFloat(completedResult.rows[0].total);
    if (newRaised >= loan.goal_amount) {
      await db.query("UPDATE loans SET status = 'funded' WHERE id = $1", [loanId]);
    }

    // Send funding confirmation email (non-blocking)
    try {
      const lenderResult = await db.query(
        'SELECT fname, email FROM lenders WHERE id = $1', [lenderId]
      );
      if (lenderResult.rows[0]) {
        const l = lenderResult.rows[0];
        const isFullyFunded = newRaised >= loan.goal_amount;
        resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL,
          to: l.email,
          subject: `You just funded ${loan.entrepreneur_name} on Manbi 🌱`,
          html: emailTemplate(`
            <h2 style="font-size:22px;color:#0F1C17;margin:0 0 8px;font-family:Georgia,serif">Your impact is live, ${l.fname}!</h2>
            <p style="font-size:15px;color:#4B5563;line-height:1.7;margin:0 0 20px">
              You just contributed <strong>GHS ${parseFloat(amount).toFixed(2)}</strong> to <strong>${loan.entrepreneur_name}</strong> in ${loan.location}. Here's what happens next.
            </p>
            <div style="background:#F0FDF4;border:1px solid #D1FAE5;border-radius:12px;padding:20px;margin-bottom:24px">
              <div style="font-size:13px;color:#374151;margin-bottom:8px"><strong>Loan:</strong> ${loan.entrepreneur_name} · ${loan.sector} · ${loan.location}</div>
              <div style="font-size:13px;color:#374151;margin-bottom:8px"><strong>Your contribution:</strong> GHS ${parseFloat(amount).toFixed(2)}</div>
              <div style="font-size:13px;color:#374151"><strong>Loan goal:</strong> GHS ${parseFloat(loan.goal_amount).toLocaleString()}</div>
            </div>
            ${isFullyFunded ? `
            <div style="background:#FFFBEA;border:1px solid #FDE68A;border-radius:12px;padding:16px;margin-bottom:20px">
              <div style="font-size:14px;color:#92400E;font-weight:600">🎉 This loan is now fully funded!</div>
              <div style="font-size:13px;color:#92400E;margin-top:4px">We'll disburse the funds to ${loan.entrepreneur_name} shortly.</div>
            </div>` : ''}
            <p style="font-size:14px;color:#4B5563;line-height:1.7;margin:0 0 20px">
              When ${loan.entrepreneur_name} makes a repayment, your proportional share will be instantly credited back to your Manbi vault.
            </p>
            <a href="${process.env.FRONTEND_URL}/manbi-dashboard.html" style="display:inline-block;background:#1A9070;color:#fff;text-decoration:none;padding:14px 28px;border-radius:50px;font-size:15px;font-weight:500">
              View your dashboard →
            </a>
          `)
        });
      }
    } catch (emailErr) {
      console.error('Funding email error:', emailErr.message);
    }

    res.status(201).json({
      message: 'Funding recorded successfully.',
      funding: funding.rows[0],
      support_amount: supportAmount
    });

  } catch (err) {
    console.error('Fund loan error:', err);
    res.status(500).json({ error: 'Failed to process funding.' });
  }
});

// ── GET REPAYMENT SCHEDULE FOR A LOAN (lender view) ──
router.get('/:id/schedule', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM repayments WHERE loan_id = $1 ORDER BY installment_number ASC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch repayment schedule.' });
  }
});

// ── GET MY FUNDED LOANS ──
router.get('/my/funded', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT l.*,
        COALESCE(SUM(f.amount), 0) as my_contribution,
        COALESCE(SUM(f2.amount), 0) as total_raised,
        ROUND((COALESCE(SUM(f2.amount), 0) / l.goal_amount * 100)::numeric, 0) as pct_funded,
        MAX(f.created_at) as funded_at
       FROM funding f
       JOIN loans l ON l.id = f.loan_id
       LEFT JOIN funding f2 ON f2.loan_id = l.id AND f2.status = 'completed'
       WHERE f.lender_id = $1 AND f.status = 'completed'
       GROUP BY l.id
       ORDER BY MAX(f.created_at) DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch your loans.' });
  }
});

module.exports = router;
