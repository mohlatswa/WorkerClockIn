-- ============================================================
--  WorkClock — Security Lockdown
--  RUN THIS *AFTER* deploying the updated app.js / index.html.
--
--  Why the order matters: the new frontend stops reading the
--  credential columns below and verifies PINs / resets passwords
--  through server-side RPCs instead. If you run this BEFORE the
--  new code is live, the OLD deployed site (which still does
--  `select('*')`) will break for workers and admins.
--
--  Verify the app works on the live URL first, THEN run this.
-- ============================================================


-- ════════════════════════════════════════════════════════════
--  PHASE 1 — STOP CREDENTIAL EXFILTRATION  (apply now)
--
--  Problem: the public anon key (shipped in config.js) could read
--  every admin password hash and every worker PIN hash, then
--  reverse them offline (PINs are only 4–6 digits; hashes are
--  unsalted SHA-256). This revokes read access to those columns
--  while leaving every column the UI actually displays readable.
-- ════════════════════════════════════════════════════════════

-- workers: hide pin + session_token
REVOKE SELECT ON public.workers FROM anon, authenticated;
GRANT  SELECT (
  id, employee_id, name, phone, email, workplace_id,
  biometric_credential_id, biometric_enabled, is_active,
  created_at, updated_at, job_title, company_id,
  face_descriptor, device_id, failed_attempts, locked_until, force_pin_change
) ON public.workers TO anon, authenticated;

-- admin_users: hide password_hash + reset_token + reset_expires
REVOKE SELECT ON public.admin_users FROM anon, authenticated;
GRANT  SELECT (
  id, username, email, is_active, created_at, role,
  full_name, company_id, failed_attempts, locked_until
) ON public.admin_users TO anon, authenticated;

-- Sanity check — both must return FALSE after running the above:
--   SELECT has_column_privilege('anon','public.admin_users','password_hash','SELECT'),
--          has_column_privilege('anon','public.workers','pin','SELECT');


-- ════════════════════════════════════════════════════════════
--  PHASE 2 — STOP ADMIN / COMPANY TAMPERING   ✅ APPLIED
--
--  admins now get a server-issued session token (admin_login_v2),
--  and every admin_users / companies write goes through a
--  SECURITY DEFINER RPC that verifies the token + the actor's
--  role/company (admin_self_*, admin_manage_*, dev_company_*,
--  dev_set_worker_limit, admin_set_timezone). Direct anon writes
--  to those two tables are revoked:
--    (migration: workclock_revoke_admin_company_writes)
--
--    REVOKE INSERT, UPDATE, DELETE ON public.admin_users FROM anon, authenticated;
--    REVOKE INSERT, UPDATE, DELETE ON public.companies  FROM anon, authenticated;
--
--  Verified: a direct `update admin_users` from the anon key now
--  fails with 42501; the RPC path still works for a logged-in admin.
-- ════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════
--  PHASE 2b — REMAINING WRITES  (still open, next milestone)
--
--  workers, workplaces and attendance are still writable by the
--  anon key within ACTIVE companies. An attacker could still reset a
--  worker's PIN, rebind devices, or forge/alter attendance rows.
--  Closing this means routing the worker clock-in path and the admin
--  worker/workplace management through session-verified RPCs (workers
--  already have session tokens; clock-in would use worker_clock_action)
--  and then revoking direct writes on those three tables. Tracked as
--  the next security task.
-- ════════════════════════════════════════════════════════════
