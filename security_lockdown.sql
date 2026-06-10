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
--  PHASE 2 — STOP CREDENTIAL / DATA TAMPERING  (recommended next)
--
--  Phase 1 stops attackers from READING credentials. Writes are
--  still open: with the anon key an attacker can currently
--    • UPDATE admin_users.password_hash for any admin id -> takeover
--    • INSERT / UPDATE companies (codes, active flag)
--    • UPDATE workers (reset PINs, rebind devices) for active cos
--    • forge attendance rows
--  because there is no logged-in identity at the DB layer — the
--  app uses the shared anon key for everything.
--
--  The correct fix is to (a) give admins a server-issued session
--  token (like workers already have), (b) move every privileged
--  write into a SECURITY DEFINER RPC that validates that token and
--  the caller's role/company, then (c) revoke direct INSERT/UPDATE
--  from anon on these tables. That is an app + DB change, so it is
--  intentionally left as a documented next step rather than run
--  blindly here (revoking writes without the RPCs would break the
--  admin panel).
--
--  Minimum hardening you CAN apply now without code changes:
--  tighten the "always true" policies so they at least require an
--  ACTIVE company context, matching the other tables. Uncomment to
--  apply (test admin login + company management afterwards):
--
--  DROP POLICY IF EXISTS admin_users_update ON public.admin_users;
--  CREATE POLICY admin_users_update ON public.admin_users FOR UPDATE
--    USING (company_id IN (SELECT id FROM companies WHERE is_active))
--    WITH CHECK (company_id IN (SELECT id FROM companies WHERE is_active));
--  -- NOTE: developer accounts have company_id = NULL, so if you apply
--  -- the above, developer self-service (profile/password) must move to
--  -- an RPC first or those updates will be blocked.
-- ════════════════════════════════════════════════════════════
