-- ============================================================
--  WorkClock — Database Schema (reflects production)
--  Run in the Supabase SQL Editor for a fresh project.
--
--  Notes:
--   • RLS is ENABLED on every table. Policies are defined below.
--   • Credentials are SHA-256 hashed by the browser before they
--     reach the database (PINs and admin passwords). They are
--     never stored in plain text.
--   • After setup, run security_lockdown.sql to revoke read access
--     to the credential columns from the anon key.
-- ============================================================

-- ── Companies (tenants) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
    id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name                    TEXT NOT NULL,
    code                    TEXT UNIQUE NOT NULL,
    is_active               BOOLEAN DEFAULT TRUE,
    clock_methods           TEXT[] DEFAULT '{pin}',
    worker_limit            INTEGER,                 -- NULL = unlimited
    timezone                TEXT DEFAULT 'Africa/Johannesburg',
    subscription_expires_at TIMESTAMPTZ,
    -- Work-shift settings (late / overtime calculation)
    shift_start             TIME DEFAULT '08:00',
    shift_end               TIME DEFAULT '17:00',
    shift_grace_min         INTEGER DEFAULT 10,
    shift_ot_mode           TEXT DEFAULT 'after_end', -- after_end | daily_9 | daily_8 | weekly_45
    work_days               INTEGER[] DEFAULT '{1,2,3,4,5}', -- ISO dow Mon=1..Sun=7
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ── Workplaces (geofenced clock-in locations) ───────────────
CREATE TABLE IF NOT EXISTS workplaces (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    address         TEXT,
    latitude        DECIMAL(10, 8) NOT NULL,
    longitude       DECIMAL(11, 8) NOT NULL,
    radius_meters   INTEGER DEFAULT 100,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Workers ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workers (
    id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id              UUID REFERENCES companies(id) ON DELETE CASCADE,
    workplace_id            UUID REFERENCES workplaces(id) ON DELETE SET NULL,
    employee_id             VARCHAR(50) NOT NULL,
    name                    VARCHAR(255) NOT NULL,
    job_title               TEXT,
    phone                   VARCHAR(20),
    email                   VARCHAR(255),
    pin                     VARCHAR(64) NOT NULL,      -- SHA-256 hash of the PIN
    force_pin_change        BOOLEAN DEFAULT FALSE,
    biometric_credential_id TEXT,                      -- WebAuthn credential id (public)
    biometric_enabled       BOOLEAN DEFAULT FALSE,
    face_descriptor         TEXT,                      -- JSON float array (face-api.js)
    device_id               TEXT,                      -- device binding
    session_token           TEXT,                      -- server-issued session
    failed_attempts         INTEGER DEFAULT 0,
    locked_until            TIMESTAMPTZ,
    is_active               BOOLEAN DEFAULT TRUE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (company_id, employee_id)
);

-- ── Attendance ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    worker_id           UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    company_id          UUID REFERENCES companies(id) ON DELETE CASCADE,
    workplace_id        UUID REFERENCES workplaces(id) ON DELETE SET NULL,
    clock_in_time       TIMESTAMPTZ,
    clock_out_time      TIMESTAMPTZ,
    clock_in_latitude   DECIMAL(10, 8),
    clock_in_longitude  DECIMAL(11, 8),
    clock_out_latitude  DECIMAL(10, 8),
    clock_out_longitude DECIMAL(11, 8),
    auth_method         VARCHAR(20) CHECK (auth_method IS NULL OR auth_method IN ('pin','biometric','qr','nfc','face','portal')),
    status              VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','completed','missed')),
    device_label        TEXT,                      -- human-readable sign-in device (OS · browser)
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Admin users (custom auth, separate from Supabase Auth) ──
CREATE TABLE IF NOT EXISTS admin_users (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id    UUID REFERENCES companies(id) ON DELETE CASCADE,
    username      VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(64) NOT NULL,             -- SHA-256 hash of the password
    full_name     TEXT,
    email         VARCHAR(255),
    role          TEXT DEFAULT 'admin',             -- 'developer' | 'super_admin' | 'admin'
    failed_attempts INTEGER DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    reset_token   VARCHAR(64),                      -- SHA-256 hash of the reset OTP
    reset_expires TIMESTAMPTZ,
    session_token TEXT,                             -- server-issued admin session (admin_login_v2)
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Audit log ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    table_name  TEXT NOT NULL,
    operation   TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
    row_id      UUID NOT NULL,
    company_id  UUID REFERENCES companies(id),
    old_data    JSONB,
    new_data    JSONB,
    changed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_attendance_worker_id ON attendance(worker_id);
CREATE INDEX IF NOT EXISTS idx_attendance_company   ON attendance(company_id);
CREATE INDEX IF NOT EXISTS idx_attendance_clock_in  ON attendance(clock_in_time);
CREATE INDEX IF NOT EXISTS idx_workers_company       ON workers(company_id);
CREATE INDEX IF NOT EXISTS idx_workers_employee_id   ON workers(company_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_workers_active        ON workers(is_active);
CREATE INDEX IF NOT EXISTS idx_admin_users_company   ON admin_users(company_id);

-- ── Row Level Security ──────────────────────────────────────
-- Every table has RLS enabled. The current policies scope reads/
-- writes to ACTIVE companies. See security_lockdown.sql for the
-- credential-column revokes and the Phase-2 write-hardening plan.
ALTER TABLE companies   ENABLE ROW LEVEL SECURITY;
ALTER TABLE workplaces  ENABLE ROW LEVEL SECURITY;
ALTER TABLE workers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance  ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log   ENABLE ROW LEVEL SECURITY;

-- The server-side auth RPCs (admin_login / admin_login_v2,
-- restore_worker_session, worker_login, worker_set_pin,
-- request_password_reset, verify_password_reset, set_worker_limit) are
-- defined as SECURITY DEFINER functions. See the Supabase migrations:
--   workclock_secure_auth_rpcs  (the PIN / password-reset RPCs)
--
-- Phase 2b write-hardening RPCs (route all worker/workplace/attendance
-- writes through the server so direct anon writes can be revoked):
--   worker_clock_action                         -> phase2b_worker_clock_rpc.sql
--   _wc_admin, admin_worker_create/update/toggle/reset_security/
--   set_face/set_biometric, admin_workplace_save,
--   worker_set_biometric/set_face/biometric_login/logout
--                                               -> phase2b_admin_worker_workplace_rpcs.sql
-- After those are live + verified, the workers/workplaces/attendance
-- INSERT/UPDATE/DELETE revokes (Section C of the clock-RPC file) close Phase 2b.
