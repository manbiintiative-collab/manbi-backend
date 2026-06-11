require('dotenv').config();
const db = require('./src/db');
const bcrypt = require('bcryptjs');

async function run() {
  try {
    const hash = await bcrypt.hash('Manbi@Admin2026', 12);
    await db.query(
      `INSERT INTO lenders (fname, lname, email, password_hash, momo_network, level, vault_balance, role)
       VALUES ('Manbi', 'Admin', 'admin@manbi.org', $1, 'MTN', 'Admin', 0, 'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = $1, role = 'admin'`,
      [hash]
    );
    console.log('Admin user created successfully!');
    console.log('Email: admin@manbi.org');
    console.log('Password: Manbi@Admin2026');
    process.exit(0);
  } catch(e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}
run();
