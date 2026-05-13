-- ============================================================
--  WorkClock — Database Schema
--  Run this entire file in your Supabase SQL Editor
-- ============================================================

-- Workplaces (where workers are allowed to clock in)
CREATE TABLE IF NOT EXISTS workplaces (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    address         TEXT,
    latitude        DECIMAL(10, 8) NOT NULL,
    longitude       DECIMAL(11, 8) NOT NULL,
    radius_meters   INTEGER DEFAULT 100,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Workers
CREATE TABLE IF NOT EXISTS workers (
    id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id             VARCHAR(50) UNIQUE NOT NULL,
    name                    VARCHAR(255) NOT NULL,
    phone                   VARCHAR(20),
    email                   VARCHAR(255),
    workplace_id            UUID REFERENCES workplaces(id) ON DELETE SET NULL,
    pin                     VARCHAR(10) NOT NULL,
    biometric_credential_id TEXT,           -- WebAuthn credential ID (base64)
    biometric_enabled       BOOLEAN DEFAULT FALSE,
    is_active               BOOLEAN DEFAULT TRUE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Attendance records
CREATE TABLE IF NOT EXISTS attendance (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    worker_id           UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    workplace_id        UUID REFERENCES workplaces(id) ON DELETE SET NULL,
    clock_in_time       TIMESTAMPTZ,
    clock_out_time      TIMESTAMPTZ,
    clock_in_latitude   DECIMAL(10, 8),
    clock_in_longitude  DECIMAL(11, 8),
    clock_out_latitude  DECIMAL(10, 8),
    clock_out_longitude DECIMAL(11, 8),
    auth_method         VARCHAR(20) CHECK (auth_method IN ('pin', 'biometric')),
    status              VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Admin users
CREATE TABLE IF NOT EXISTS admin_users (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    username      VARCHAR(50) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email         VARCHAR(255),
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Default admin — CHANGE PASSWORD after first login!
INSERT INTO admin_users (username, password_hash, email)
VALUES ('admin', 'admin123', 'admin@workclock.com')
ON CONFLICT (username) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_attendance_worker_id    ON attendance(worker_id);
CREATE INDEX IF NOT EXISTS idx_attendance_clock_in     ON attendance(clock_in_time);
CREATE INDEX IF NOT EXISTS idx_workers_employee_id     ON workers(employee_id);
CREATE INDEX IF NOT EXISTS idx_workers_workplace_id    ON workers(workplace_id);
CREATE INDEX IF NOT EXISTS idx_workers_active          ON workers(is_active);

-- Disable RLS for initial setup (configure RLS policies for production)
ALTER TABLE workplaces   DISABLE ROW LEVEL SECURITY;
ALTER TABLE workers      DISABLE ROW LEVEL SECURITY;
ALTER TABLE attendance   DISABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users  DISABLE ROW LEVEL SECURITY;
