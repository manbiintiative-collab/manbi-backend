const router = require('express').Router();
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

// ── GET ALL ENTREPRENEUR APPLICATIONS ──
router.get('/applications', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM borrower_interests ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch applications.' });
  }
});

// ── CREATE LOAN LISTING (approve entrepreneur) ──
router.post('/loans', requireAdmin, async (req, res) => {
  const {
    entrepreneur_name, initials, location, sector,
    purpose, goal_amount, loan_term_months, repayment_plan,
    narrative, profile_photo_url, video_url
  } = req.body;

  if (!entrepreneur_name || !location || !sector || !purpose || !goal_amount) {
    return res.status(400).json({ error: 'Please fill in all required fields.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO loans (
        entrepreneur_name, initials, location, sector,
        purpose, goal_amount, loan_term_months, repayment_plan,
        narrative, profile_photo_url, video_url, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active')
      RETURNING *`,
      [
        entrepreneur_name, initials || entrepreneur_name.substring(0,2).toUpperCase(),
        location, sector, purpose, goal_amount,
        loan_term_months || 6, repayment_plan, narrative,
        profile_photo_url, video_url
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create loan error:', err);
    res.status(500).json({ error: 'Failed to create loan.' });
  }
});

// ── UPDATE LOAN STATUS ──
router.patch('/loans/:id', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['active', 'funded', 'disbursed', 'repaid', 'closed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    const result = await db.query(
      'UPDATE loans SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update loan.' });
  }
});

// ── GET PLATFORM STATS ──
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [lenders, loans, funding, interests] = await Promise.all([
      db.query('SELECT COUNT(*) FROM lenders'),
      db.query('SELECT COUNT(*), status FROM loans GROUP BY status'),
      db.query('SELECT COALESCE(SUM(amount),0) as total, COALESCE(SUM(support_amount),0) as support FROM funding'),
      db.query("SELECT COUNT(*) FROM borrower_interests WHERE status = 'pending'")
    ]);

    res.json({
      total_lenders: parseInt(lenders.rows[0].count),
      loans_by_status: loans.rows,
      total_funded: parseFloat(funding.rows[0].total),
      total_support_collected: parseFloat(funding.rows[0].support),
      pending_applications: parseInt(interests.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

module.exports = router;
