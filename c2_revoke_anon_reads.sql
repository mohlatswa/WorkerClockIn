-- ============================================================================
-- C2 READ LOCKDOWN — STAGE 1 (THE REVOKES)  ⚠️ DO NOT RUN UNTIL STAGE 0 VERIFIED
-- ----------------------------------------------------------------------------
-- Prerequisite: the RPC-based frontend (app.js APP_VERSION v40+, using rpcRead
-- for every companies/workers/workplaces/attendance/audit_log read) MUST be
-- deployed to GitHub Pages AND verified working live end-to-end:
--   • worker login: company link → Employee ID + PIN, biometric, face
--   • worker dashboard: today's record + 14-day history
--   • admin: dashboard counts, workers list, attendance report + CSV, audit,
--            absent, leave, setup (workplace/timezone/usage/subscription)
--   • developer console: companies, accounts, workers, inactive
-- Only after all of the above work on the DEPLOYED build do you run this file.
--
-- Run ONE table at a time, safest first, re-verifying the live app + the anon
-- read count after each. Rollback for any table is a single GRANT (bottom).
-- After a table is revoked, the app.js direct-select fallback for that table is
-- dead code and can be deleted in a later cleanup commit (optional).
-- ============================================================================

-- ── 1. audit_log (lowest risk: admin-only read, one call site) ──────────────
REVOKE SELECT ON public.audit_log   FROM anon, authenticated;

-- ── 2. attendance ───────────────────────────────────────────────────────────
REVOKE SELECT ON public.attendance  FROM anon, authenticated;

-- ── 3. workplaces ────────────────────────────────────────────────────────────
REVOKE SELECT ON public.workplaces  FROM anon, authenticated;

-- ── 4. workers (also drop the lingering column-level grants) ─────────────────
REVOKE SELECT ON public.workers     FROM anon, authenticated;

-- ── 5. companies  ⚠️ LAST — login (public_company_by_code / _for_login) depends
--       on it via SECURITY DEFINER RPCs, which keep working after this revoke. ──
REVOKE SELECT ON public.companies   FROM anon, authenticated;

-- ── VERIFY (run as needed) ──────────────────────────────────────────────────
-- SET ROLE anon;
-- SELECT 'workers' t, count(*) FROM workers
-- UNION ALL SELECT 'companies', count(*) FROM companies
-- UNION ALL SELECT 'workplaces', count(*) FROM workplaces
-- UNION ALL SELECT 'attendance', count(*) FROM attendance
-- UNION ALL SELECT 'audit_log', count(*) FROM audit_log;   -- expect: all error/0
-- RESET ROLE;
-- Preferred (won't error): confirm no grants remain —
-- SELECT table_name FROM information_schema.role_table_grants
--  WHERE grantee IN ('anon','authenticated') AND privilege_type='SELECT'
--    AND table_name IN ('companies','workers','workplaces','attendance','audit_log');

-- ── ROLLBACK (per table, if the app breaks) ─────────────────────────────────
-- GRANT SELECT ON public.audit_log  TO anon, authenticated;
-- GRANT SELECT ON public.attendance TO anon, authenticated;
-- GRANT SELECT ON public.workplaces TO anon, authenticated;
-- GRANT SELECT ON public.workers    TO anon, authenticated;
-- GRANT SELECT ON public.companies  TO anon, authenticated;

-- RESIDUAL AFTER THIS FILE: within-company face_descriptor exposure to anyone
-- holding a company's code (face_login_candidates(company_id)). Closing that
-- fully = issue #5 (server-side WebAuthn/face verification).
