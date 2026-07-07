const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const crypto = require('crypto');

// ── MOOLRE CONFIG ──
const MOOLRE_URL = process.env.MOOLRE_API_URL || 'https://api.moolre.com';
const MOOLRE_USER = process.env.MOOLRE_USERNAME;
const MOOLRE_KEY = process.env.MOOLRE_API_KEY;
const MOOLRE_PUBKEY = process.env.MOOLRE_PUBLIC_KEY;
const MOOLRE_ACCOUNT = process.env.MOOLRE_ACCOUNT_NUMBER;

// Channel mapping
const CHANNEL_MAP = { mtn: '13', telecel: '6', airteltigo: '7' };

// ── GENERATE UNIQUE EXTERNAL REF ──
function genRef(prefix) {
  return prefix + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

// ── INITIATE COLLECTION (lender funds a loan) ──
router.post('/collect', requireAuth, async (req, res) => {
  const { loan_id, amount, phone_number, network, include_support } = req.body;
  const lender_id = req.user.id;

  if (!loan_id || !amount || !phone_number || !network) {
    return res.status(400).json({ error: 'loan_id, amount, phone_number and network are required.' });
  }
  if (amount < 10) {
    return res.status(400).json({ error: 'Minimum funding amount is GHS 10.' });
  }

  const channel = CHANNEL_MAP[network.toLowerCase()];
  if (!channel) {
    return res.status(400).json({ error: 'Invalid network. Use mtn, telecel, or airteltigo.' });
  }

  try {
    // Verify loan is active and not overfunded
    const loanResult = await db.query(
      `SELECT l.*, COALESCE(SUM(f.amount), 0) as raised
       FROM loans l LEFT JOIN funding f ON f.loan_id = l.id
       WHERE l.id = $1 AND l.status = 'active' AND (l.suspended IS NULL OR l.suspended = FALSE)
       GROUP BY l.id`,
      [loan_id]
    );
    if (!loanResult.rows[0]) {
      return res.status(404).json({ error: 'Loan not found or no longer active.' });
    }
    const loan = loanResult.rows[0];
    const remaining = parseFloat(loan.goal_amount) - parseFloat(loan.raised);
    if (amount > remaining) {
      return res.status(400).json({ error: `Maximum you can fund is GHS ${remaining.toFixed(2)}.` });
    }

    const supportAmount = include_support ? parseFloat((amount * 0.05).toFixed(2)) : 0;
    const externalRef = genRef('COL');

    // Record as pending in DB first
    const funding = await db.query(
      `INSERT INTO funding (loan_id, lender_id, amount, support_amount, payment_method, phone_number, status, external_ref)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING *`,
      [loan_id, lender_id, amount, supportAmount, network, phone_number, externalRef]
    );

    // Initiate Moolre collection
    const moolreRes = await fetch(`${MOOLRE_URL}/open/transact/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-USER': MOOLRE_USER,
        'X-API-KEY': MOOLRE_KEY
      },
      body: JSON.stringify({
        type: 1,
        channel,
        currency: 'GHS',
        payer: phone_number,
        amount: amount.toString(),
        externalref: externalRef,
        accountnumber: MOOLRE_ACCOUNT
      })
    });

    const moolreData = await moolreRes.json();

    if (moolreData.status !== 1 && moolreData.status !== '1') {
      // Moolre rejected — update funding record to failed
      await db.query("UPDATE funding SET status = 'failed' WHERE id = $1", [funding.rows[0].id]);
      return res.status(400).json({ error: moolreData.message || 'Payment initiation failed.' });
    }

    // Store Moolre transaction ID
    const moolreTxId = moolreData.data || null;
    await db.query(
      "UPDATE funding SET moolre_tx_id = $1 WHERE id = $2",
      [moolreTxId, funding.rows[0].id]
    );

    res.json({
      message: 'Payment request sent. Please approve the USSD prompt on your phone.',
      external_ref: externalRef,
      moolre_tx_id: moolreTxId,
      funding_id: funding.rows[0].id,
      requires_otp: moolreData.code === 'TP14'
    });

  } catch (err) {
    console.error('Collection error:', err.message);
    res.status(500).json({ error: 'Failed to initiate payment.' });
  }
});

// ── CHECK PAYMENT STATUS ──
router.post('/status', requireAuth, async (req, res) => {
  const { external_ref } = req.body;
  if (!external_ref) return res.status(400).json({ error: 'external_ref is required.' });

  try {
    const moolreRes = await fetch(`${MOOLRE_URL}/open/transact/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-USER': MOOLRE_USER,
        'X-API-PUBKEY': MOOLRE_PUBKEY
      },
      body: JSON.stringify({
        type: 1,
        idtype: '1',
        id: external_ref,
        accountnumber: MOOLRE_ACCOUNT
      })
    });

    const moolreData = await moolreRes.json();
    const txStatus = moolreData.data && moolreData.data.txstatus;

    if (txStatus === 1) {
      // Payment confirmed — update funding record
      await confirmFunding(external_ref);
      return res.json({ status: 'confirmed', message: 'Payment confirmed.' });
    } else if (txStatus === 0) {
      return res.json({ status: 'failed', message: 'Payment failed or was rejected.' });
    } else {
      return res.json({ status: 'pending', message: 'Payment is still pending approval.' });
    }
  } catch (err) {
    console.error('Status check error:', err.message);
    res.status(500).json({ error: 'Failed to check payment status.' });
  }
});

// ── MOOLRE WEBHOOK (payment confirmed callback) ──
router.post('/webhook', async (req, res) => {
  try {
    const { status, data } = req.body;
    if (status !== 1 && status !== '1') {
      return res.json({ received: true });
    }
    if (data && data.externalref) {
      await confirmFunding(data.externalref);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

// ── CONFIRM FUNDING (shared logic for webhook + polling) ──
async function confirmFunding(externalRef) {
  const fundingResult = await db.query(
    "SELECT * FROM funding WHERE external_ref = $1 AND status = 'pending'",
    [externalRef]
  );
  if (!fundingResult.rows[0]) return; // Already confirmed or not found

  const funding = fundingResult.rows[0];

  // Mark as completed
  await db.query(
    "UPDATE funding SET status = 'completed' WHERE id = $1",
    [funding.id]
  );

  // Check if loan is now fully funded
  const loanResult = await db.query(
    `SELECT l.goal_amount, COALESCE(SUM(f.amount), 0) as raised
     FROM loans l LEFT JOIN funding f ON f.loan_id = l.id AND f.status = 'completed'
     WHERE l.id = $1 GROUP BY l.id`,
    [funding.loan_id]
  );
  if (loanResult.rows[0]) {
    const { goal_amount, raised } = loanResult.rows[0];
    if (parseFloat(raised) >= parseFloat(goal_amount)) {
      await db.query("UPDATE loans SET status = 'funded' WHERE id = $1", [funding.loan_id]);
    }
  }

  // Send confirmation email
  try {
    const { emailTemplate, resend } = require('./auth');
    const lenderResult = await db.query(
      'SELECT fname, email FROM lenders WHERE id = $1', [funding.lender_id]
    );
    const loanInfo = await db.query(
      'SELECT entrepreneur_name, location, sector, goal_amount FROM loans WHERE id = $1',
      [funding.loan_id]
    );
    if (lenderResult.rows[0] && loanInfo.rows[0]) {
      const l = lenderResult.rows[0];
      const ln = loanInfo.rows[0];
      resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL,
        to: l.email,
        subject: `You just funded ${ln.entrepreneur_name} on Manbi 🌱`,
        html: emailTemplate(`
          <h2 style="font-size:22px;color:#0F1C17;margin:0 0 8px;font-family:Georgia,serif">Your impact is live, ${l.fname}!</h2>
          <p style="font-size:15px;color:#4B5563;line-height:1.7;margin:0 0 20px">
            Your payment of <strong>GHS ${parseFloat(funding.amount).toFixed(2)}</strong> to <strong>${ln.entrepreneur_name}</strong> has been confirmed.
          </p>
          <a href="${process.env.FRONTEND_URL}/manbi-dashboard.html" style="display:inline-block;background:#1A9070;color:#fff;text-decoration:none;padding:14px 28px;border-radius:50px;font-size:15px;font-weight:500">
            View your dashboard →
          </a>
        `)
      });
    }
  } catch (emailErr) {
    console.error('Funding confirmation email error:', emailErr.message);
  }
}

// ── DISBURSE LOAN (admin triggers payout to entrepreneur) ──
router.post('/disburse/:loan_id', requireAdmin, async (req, res) => {
  const { phone_number, network, disbursed_at } = req.body;
  const loan_id = req.params.loan_id;

  if (!phone_number || !network) {
    return res.status(400).json({ error: 'phone_number and network are required.' });
  }

  const channel = CHANNEL_MAP[network.toLowerCase()];
  if (!channel) {
    return res.status(400).json({ error: 'Invalid network. Use mtn, telecel, or airteltigo.' });
  }

  try {
    const loanResult = await db.query('SELECT * FROM loans WHERE id = $1', [loan_id]);
    if (!loanResult.rows[0]) return res.status(404).json({ error: 'Loan not found.' });
    const loan = loanResult.rows[0];

    if (loan.status !== 'funded') {
      return res.status(400).json({ error: 'Loan must be fully funded before disbursement.' });
    }

    const externalRef = genRef('DIS');

    // Initiate Moolre transfer
    const moolreRes = await fetch(`${MOOLRE_URL}/open/transact/transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-USER': MOOLRE_USER,
        'X-API-KEY': MOOLRE_KEY
      },
      body: JSON.stringify({
        type: 1,
        channel,
        currency: 'GHS',
        amount: loan.goal_amount.toString(),
        receiver: phone_number,
        externalref: externalRef,
        reference: `Manbi loan disbursement — ${loan.entrepreneur_name}`,
        accountnumber: MOOLRE_ACCOUNT
      })
    });

    const moolreData = await moolreRes.json();

    if (moolreData.status !== 1 && moolreData.status !== '1') {
      return res.status(400).json({ error: moolreData.message || 'Disbursement failed.' });
    }

    // Generate repayment schedule and mark as disbursed
    const startDate = disbursed_at ? new Date(disbursed_at) : new Date();
    const track = loan.repayment_track || 'standard';
    const term = parseInt(loan.loan_term_months) || 6;
    const goal = parseFloat(loan.goal_amount);

    await db.query('DELETE FROM repayments WHERE loan_id = $1', [loan_id]);

    const schedule = [];
    if (track === 'agricultural') {
      const gracePeriod = Math.floor(term * 0.6);
      const repaymentMonths = term - gracePeriod;
      const installment = parseFloat((goal / repaymentMonths).toFixed(2));
      for (let i = 1; i <= term; i++) {
        const dueDate = new Date(startDate);
        dueDate.setMonth(dueDate.getMonth() + i);
        schedule.push({ installment_number: i, due_date: dueDate.toISOString().split('T')[0], amount: i <= gracePeriod ? 0 : installment });
      }
    } else {
      const installment = parseFloat((goal / term).toFixed(2));
      for (let i = 1; i <= term; i++) {
        const dueDate = new Date(startDate);
        dueDate.setMonth(dueDate.getMonth() + i);
        schedule.push({ installment_number: i, due_date: dueDate.toISOString().split('T')[0], amount: installment });
      }
    }

    for (const s of schedule) {
      await db.query(
        'INSERT INTO repayments (loan_id, installment_number, due_date, amount, status) VALUES ($1,$2,$3,$4,$5)',
        [loan_id, s.installment_number, s.due_date, s.amount, 'pending']
      );
    }

    await db.query(
      "UPDATE loans SET status = 'disbursed', disbursed_at = $1 WHERE id = $2",
      [startDate.toISOString(), loan_id]
    );

    res.json({
      message: `GHS ${loan.goal_amount} disbursed to ${phone_number} successfully.`,
      moolre_tx_id: moolreData.data && moolreData.data.transactionid,
      schedule
    });

  } catch (err) {
    console.error('Disbursement error:', err.message);
    res.status(500).json({ error: 'Failed to disburse loan.' });
  }
});

module.exports = router;
module.exports.confirmFunding = confirmFunding;
