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

// ── GET ALL LOANS (ANY STATUS) — FOR ADMIN PANEL ──
router.get('/loans', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT l.*,
        COALESCE(SUM(f.amount), 0) as raised,
        ROUND((COALESCE(SUM(f.amount), 0) / l.goal_amount * 100)::numeric, 0) as pct_funded
       FROM loans l
       LEFT JOIN funding f ON f.loan_id = l.id
       GROUP BY l.id
       ORDER BY
         CASE l.status
           WHEN 'funded' THEN 1
           WHEN 'active' THEN 2
           WHEN 'disbursed' THEN 3
           WHEN 'repaid' THEN 4
           WHEN 'closed' THEN 5
         END,
         l.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get all admin loans error:', err);
    res.status(500).json({ error: 'Failed to fetch loans.' });
  }
});

// ── CREATE LOAN LISTING (approve entrepreneur) ──
router.post('/loans', requireAdmin, async (req, res) => {
  const {
    entrepreneur_name, initials, location, sector,
    purpose, goal_amount, loan_term_months, repayment_plan,
    narrative, profile_photo_url, video_url,
    partner_name, partner_description, partner_logo_url, partner_contact,
    featured, repayment_track
  } = req.body;

  if (!entrepreneur_name || !location || !sector || !purpose || !goal_amount) {
    return res.status(400).json({ error: 'Please fill in all required fields.' });
  }

  try {
    // If featuring this loan, unfeature all others first
    if (featured) {
      await db.query('UPDATE loans SET featured = FALSE WHERE featured = TRUE');
    }

    const result = await db.query(
      `INSERT INTO loans (
        entrepreneur_name, initials, location, sector,
        purpose, goal_amount, loan_term_months, repayment_plan,
        narrative, profile_photo_url, video_url,
        partner_name, partner_description, partner_logo_url, partner_contact,
        featured, repayment_track, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active')
      RETURNING *`,
      [
        entrepreneur_name, initials || entrepreneur_name.substring(0,2).toUpperCase(),
        location, sector, purpose, goal_amount,
        loan_term_months || 6, repayment_plan, narrative,
        profile_photo_url, video_url,
        partner_name || null, partner_description || null,
        partner_logo_url || null, partner_contact || null,
        featured || false, repayment_track || 'standard'
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create loan error:', err);
    res.status(500).json({ error: 'Failed to create loan.' });
  }
});

// ── GET FEATURED LOAN ──
router.get('/featured', async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM loans WHERE featured = TRUE AND status = 'active' LIMIT 1"
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch featured loan.' });
  }
});

// ── FEATURE AN EXISTING LOAN ──
router.patch('/loans/:id/feature', requireAdmin, async (req, res) => {
  try {
    await db.query('UPDATE loans SET featured = FALSE WHERE featured = TRUE');
    const result = await db.query(
      'UPDATE loans SET featured = TRUE WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Loan not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to feature loan.' });
  }
});
router.get('/loans/:id/funders', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
        f.amount,
        f.anonymous,
        f.created_at,
        l.fname,
        l.lname,
        l.profile_photo_url
       FROM funding f
       JOIN lenders l ON f.lender_id = l.id
       WHERE f.loan_id = $1
       ORDER BY f.created_at ASC`,
      [req.params.id]
    );
    const funders = result.rows.map(function(r) {
      if (r.anonymous) {
        return { amount: r.amount, anonymous: true, created_at: r.created_at };
      }
      return {
        amount: r.amount,
        anonymous: false,
        full_name: (r.fname || '') + ' ' + (r.lname || ''),
        profile_photo_url: r.profile_photo_url || null,
        created_at: r.created_at
      };
    });
    res.json(funders);
  } catch (err) {
    console.error('Funders error:', err);
    res.status(500).json({ error: 'Failed to fetch funders.' });
  }
});

// ── GET ALL LENDERS ──
router.get('/lenders', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
        l.id, l.fname, l.lname, l.email, l.momo_number, l.momo_network,
        l.vault_balance, l.level, l.role, l.created_at, l.profile_photo_url,
        COUNT(DISTINCT f.loan_id) as loans_funded,
        COALESCE(SUM(f.amount), 0) as total_funded
       FROM lenders l
       LEFT JOIN funding f ON f.lender_id = l.id
       GROUP BY l.id
       ORDER BY l.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get lenders error:', err);
    res.status(500).json({ error: 'Failed to fetch lenders.' });
  }
});

// ── GENERATE REPAYMENT SCHEDULE ──
router.post('/loans/:id/repayment-schedule', requireAdmin, async (req, res) => {
  const { disbursed_at } = req.body;
  const loanId = req.params.id;
  try {
    const loanResult = await db.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    if (!loanResult.rows[0]) return res.status(404).json({ error: 'Loan not found.' });
    const loan = loanResult.rows[0];
    const track = loan.repayment_track || 'standard';
    const term = parseInt(loan.loan_term_months) || 6;
    const goal = parseFloat(loan.goal_amount);
    const startDate = disbursed_at ? new Date(disbursed_at) : new Date();

    // Delete any existing schedule for this loan
    await db.query('DELETE FROM repayments WHERE loan_id = $1', [loanId]);

    const schedule = [];
    if (track === 'agricultural') {
      // Grace period for first 2/3 of term, repayments in last 1/3
      const gracePeriod = Math.floor(term * 0.6);
      const repaymentMonths = term - gracePeriod;
      const installment = parseFloat((goal / repaymentMonths).toFixed(2));
      for (let i = 1; i <= term; i++) {
        const dueDate = new Date(startDate);
        dueDate.setMonth(dueDate.getMonth() + i);
        schedule.push({
          installment_number: i,
          due_date: dueDate.toISOString().split('T')[0],
          amount: i <= gracePeriod ? 0 : installment,
          status: 'pending'
        });
      }
    } else {
      // Standard — equal monthly installments
      const installment = parseFloat((goal / term).toFixed(2));
      for (let i = 1; i <= term; i++) {
        const dueDate = new Date(startDate);
        dueDate.setMonth(dueDate.getMonth() + i);
        schedule.push({
          installment_number: i,
          due_date: dueDate.toISOString().split('T')[0],
          amount: installment,
          status: 'pending'
        });
      }
    }

    // Insert all installments
    for (const s of schedule) {
      await db.query(
        'INSERT INTO repayments (loan_id, installment_number, due_date, amount, status) VALUES ($1,$2,$3,$4,$5)',
        [loanId, s.installment_number, s.due_date, s.amount, s.status]
      );
    }

    // Mark loan as disbursed
    await db.query(
      "UPDATE loans SET status = 'disbursed', disbursed_at = $1 WHERE id = $2",
      [startDate.toISOString(), loanId]
    );

    res.json({ message: 'Repayment schedule generated.', schedule });
  } catch (err) {
    console.error('Repayment schedule error:', err);
    res.status(500).json({ error: 'Failed to generate repayment schedule.' });
  }
});

// ── GET REPAYMENT SCHEDULE FOR A LOAN ──
router.get('/loans/:id/repayments', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM repayments WHERE loan_id = $1 ORDER BY installment_number ASC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch repayments.' });
  }
});

// ── MARK REPAYMENT AS PAID ──
router.patch('/repayments/:id/paid', requireAdmin, async (req, res) => {
  try {
    // Mark installment as paid
    const result = await db.query(
      "UPDATE repayments SET status = 'paid', paid_at = NOW() WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Repayment not found.' });

    const repayment = result.rows[0];
    const loanId = repayment.loan_id;
    const installmentAmount = parseFloat(repayment.amount);

    // Only credit vaults if installment amount > 0 (agricultural grace months = 0)
    if (installmentAmount > 0) {
      // Get total loan amount and all lenders who funded this loan
      const loanResult = await db.query(
        'SELECT goal_amount FROM loans WHERE id = $1',
        [loanId]
      );
      const goalAmount = parseFloat(loanResult.rows[0].goal_amount);

      const fundersResult = await db.query(
        `SELECT lender_id, SUM(amount) as contributed
         FROM funding
         WHERE loan_id = $1
         GROUP BY lender_id`,
        [loanId]
      );

      // Credit each lender's vault proportionally
      for (const funder of fundersResult.rows) {
        const proportion = parseFloat(funder.contributed) / goalAmount;
        const share = parseFloat((installmentAmount * proportion).toFixed(2));
        if (share > 0) {
          await db.query(
            'UPDATE lenders SET vault_balance = COALESCE(vault_balance, 0) + $1 WHERE id = $2',
            [share, funder.lender_id]
          );
          // Log the transaction
          await db.query(
            `INSERT INTO transactions (lender_id, type, amount, payment_method, status, created_at)
             VALUES ($1, 'repayment_credit', $2, 'vault', 'completed', NOW())`,
            [funder.lender_id, share]
          );
        }
      }
    }

    // Check if all repayments for this loan are paid — if so mark loan repaid
    const check = await db.query(
      "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid FROM repayments WHERE loan_id = $1",
      [loanId]
    );
    const { total, paid } = check.rows[0];
    if (parseInt(paid) >= parseInt(total)) {
      await db.query("UPDATE loans SET status = 'repaid' WHERE id = $1", [loanId]);
    }

    res.json({
      repayment: result.rows[0],
      message: installmentAmount > 0
        ? 'Repayment marked as paid. Lender vaults credited.'
        : 'Grace period installment marked. No vault credits issued.'
    });
  } catch (err) {
    console.error('Mark repayment paid error:', err);
    res.status(500).json({ error: 'Failed to mark repayment as paid.' });
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
    res.json({ ...result.rows[0], needs_schedule: status === 'disbursed' });
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
