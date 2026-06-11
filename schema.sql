CREATE TABLE IF NOT EXISTS lenders (
  id              SERIAL PRIMARY KEY,
  fname           VARCHAR(100) NOT NULL,
  lname           VARCHAR(100) NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  momo_number     VARCHAR(20),
  momo_network    VARCHAR(20) DEFAULT 'MTN',
  vault_balance   DECIMAL(10,2) DEFAULT 0,
  level           VARCHAR(50) DEFAULT 'Seed Sower',
  avatar          VARCHAR(10) DEFAULT '🌱',
  squad           VARCHAR(100),
  role            VARCHAR(20) DEFAULT 'lender',
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loans (
  id                  SERIAL PRIMARY KEY,
  entrepreneur_name   VARCHAR(200) NOT NULL,
  initials            VARCHAR(5),
  location            VARCHAR(200) NOT NULL,
  sector              VARCHAR(50) NOT NULL,
  purpose             TEXT NOT NULL,
  narrative           TEXT,
  goal_amount         DECIMAL(10,2) NOT NULL,
  loan_term_months    INTEGER DEFAULT 6,
  repayment_plan      TEXT,
  profile_photo_url   TEXT,
  video_url           TEXT,
  status              VARCHAR(20) DEFAULT 'active',
  created_at          TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS funding (
  id                SERIAL PRIMARY KEY,
  loan_id           INTEGER REFERENCES loans(id),
  lender_id         INTEGER REFERENCES lenders(id),
  amount            DECIMAL(10,2) NOT NULL,
  support_amount    DECIMAL(10,2) DEFAULT 0,
  payment_method    VARCHAR(20),
  phone_number      VARCHAR(20),
  status            VARCHAR(20) DEFAULT 'pending',
  repayment_action  VARCHAR(20),
  created_at        TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id              SERIAL PRIMARY KEY,
  lender_id       INTEGER REFERENCES lenders(id),
  type            VARCHAR(20) NOT NULL,
  amount          DECIMAL(10,2) NOT NULL,
  payment_method  VARCHAR(20),
  phone_number    VARCHAR(20),
  status          VARCHAR(20) DEFAULT 'pending',
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS borrower_interests (
  id            SERIAL PRIMARY KEY,
  full_name     VARCHAR(200) NOT NULL,
  phone         VARCHAR(20) NOT NULL,
  community     VARCHAR(200) NOT NULL,
  amount_range  VARCHAR(50),
  purpose       TEXT,
  status        VARCHAR(20) DEFAULT 'pending',
  created_at    TIMESTAMP DEFAULT NOW()
);