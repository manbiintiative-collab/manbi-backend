const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// ── GET ALL OPEN LOANS ──
router.get('/', async (req, res) => {
  const { sector, search } = req.query;
  try {
    let query = `
      SELECT l.*, 
        COALESCE(SUM(f.amount), 0) as raised,
        ROUND((COALESCE(SUM(f.amount), 0) / l.goal_amount * 100)::numeric, 0) as pct_funded
      FROM loans l
      LEFT JOIN funding f ON f.loan_id = l.id
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
       LEFT JOIN funding f ON f.loan_id = l.id
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
       FROM loans l LEFT JOIN funding f ON f.loan_id = l.id
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

    // Record funding
    const funding = await db.query(
      `INSERT INTO funding (loan_id, lender_id, amount, support_amount, payment_method, phone_number, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [loanId, lenderId, amount, supportAmount, payment_method, phone_number]
    );

    // Check if loan is now fully funded
    const newRaised = parseFloat(loan.raised) + parseFloat(amount);
    if (newRaised >= loan.goal_amount) {
      await db.query("UPDATE loans SET status = 'funded' WHERE id = $1", [loanId]);
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

// ── GET MY FUNDED LOANS ──
router.get('/my/funded', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT l.*, f.amount as my_contribution, f.status as payment_status,
        f.created_at as funded_at,
        COALESCE(SUM(f2.amount), 0) as total_raised,
        ROUND((COALESCE(SUM(f2.amount), 0) / l.goal_amount * 100)::numeric, 0) as pct_funded
       FROM funding f
       JOIN loans l ON l.id = f.loan_id
       LEFT JOIN funding f2 ON f2.loan_id = l.id
       WHERE f.lender_id = $1
       GROUP BY l.id, f.amount, f.status, f.created_at
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch your loans.' });
  }
});

module.exports = router;
