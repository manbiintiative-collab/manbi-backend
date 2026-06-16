require('dotenv').config();
const db = require('./src/db');
const bcrypt = require('bcryptjs');

async function run() {
  try {
    const hash = await bcrypt.hash('Noceilings@2000', 12);
    await db.query(
      `INSERT INTO lenders (fname, lname, email, password_hash, momo_network, role, level)
       VALUES ('Manbi', 'Admin', 'admin@manbi.org', $1, 'MTN', 'Admin', 1)
       ON CONFLICT (email) DO UPDATE SET password_hash = $1, role = 'Admin'`,
      [hash]
    );
    console.log('Admin user created successfully!');
    console.log('Email: admin@manbi.org');
    console.log('Password: Noceilings@2000');
    process.exit(0);
  } catch(e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

run();
