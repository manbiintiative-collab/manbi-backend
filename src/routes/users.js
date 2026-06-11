const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// ── GET DASHBOARD STATS ──
router.get('/stats', requireAuth, async (req, res) => {
  const lenderId = req.user.id;
  try {
    const [vaultRes, activeRes, totalRes, repaidRes] = await Promise.all([
      db.query('SELECT vault_balance FROM lenders WHERE id = $1', [lenderId]),
      db.query("SELECT COUNT(*) FROM funding WHERE lender_id = $1 AND status = 'active'", [lenderId]),
      db.query('SELECT COALESCE(SUM(amount), 0) as total FROM funding WHERE lender_id = $1', [lenderId]),
      db.query("SELECT COUNT(*) FROM funding WHERE lender_id = $1 AND status = 'repaid'", [lenderId])
    ]);

    res.json({
      vault_balance: vaultRes.rows[0].vault_balance,
      active_loans: parseInt(activeRes.rows[0].count),
      total_deployed: parseFloat(totalRes.rows[0].total),
      repaid_loans: parseInt(repaidRes.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

// ── UPDATE PROFILE (avatar, squad) ──
router.patch('/profile', requireAuth, async (req, res) => {
  const { avatar, squad, fname, lname } = req.body;
  try {
    const result = await db.query(
      `UPDATE lenders SET
        avatar = COALESCE($1, avatar),
        squad = COALESCE($2, squad),
        fname = COALESCE($3, fname),
        lname = COALESCE($4, lname)
       WHERE id = $5
       RETURNING id, fname, lname, email, momo_number, level, vault_balance, avatar, squad`,
      [avatar, squad, fname, lname, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// ── TOP UP VAULT ──
router.post('/vault/topup', requireAuth, async (req, res) => {
  const { amount, payment_method, phone_number } = req.body;
  if (!amount || amount < 10) {
    return res.status(400).json({ error: 'Minimum top up is GHS 10.' });
  }
  try {
    // Record transaction
    await db.query(
      `INSERT INTO transactions (lender_id, type, amount, payment_method, phone_number, status)
       VALUES ($1, 'topup', $2, $3, $4, 'pending')`,
      [req.user.id, amount, payment_method, phone_number]
    );
    // In production: trigger MoMo payment here via Hubtel API
    res.json({ message: 'Top up initiated. Funds will reflect shortly.', amount });
  } catch (err) {
    res.status(500).json({ error: 'Top up failed.' });
  }
});

// ── HANDLE REPAYMENT (reinvest / cashout / donate) ──
router.post('/repayment/action', requireAuth, async (req, res) => {
  const { funding_id, action, phone_number } = req.body;
  const validActions = ['reinvest', 'cashout', 'donate'];

  if (!validActions.includes(action)) {
    return res.status(400).json({ error: 'Invalid action.' });
  }

  try {
    const fundingRes = await db.query(
      "SELECT * FROM funding WHERE id = $1 AND lender_id = $2 AND status = 'repaid'",
      [funding_id, req.user.id]
    );
    if (fundingRes.rows.length === 0) {
      return res.status(404).json({ error: 'Repaid funding record not found.' });
    }

    await db.query(
      'UPDATE funding SET repayment_action = $1 WHERE id = $2',
      [action, funding_id]
    );

    if (action === 'reinvest') {
      await db.query(
        'UPDATE lenders SET vault_balance = vault_balance + $1 WHERE id = $2',
        [fundingRes.rows[0].amount, req.user.id]
      );
    }

    const messages = {
      reinvest: 'Amount added back to your vault.',
      cashout: 'Withdrawal initiated to your MoMo wallet.',
      donate: 'Thank you for donating to Manbi!'
    };

    res.json({ message: messages[action], action });
  } catch (err) {
    res.status(500).json({ error: 'Action failed.' });
  }
});

// ── SUBMIT BORROWER INTEREST ──
router.post('/interest', async (req, res) => {
  const { full_name, phone, community, amount_range, purpose } = req.body;
  if (!full_name || !phone || !community || !amount_range || !purpose) {
    return res.status(400).json({ error: 'Please fill in all fields.' });
  }
  try {
    await db.query(
      `INSERT INTO borrower_interests (full_name, phone, community, amount_range, purpose)
       VALUES ($1, $2, $3, $4, $5)`,
      [full_name, phone, community, amount_range, purpose]
    );
    res.status(201).json({ message: 'Interest submitted. An agent will contact you within 48 hours.' });
  } catch (err) {
    res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
});

module.exports = router;
