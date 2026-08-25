-- ============================================================================
-- C2 READ LOCKDOWN — STAGE 0 (ADDITIVE, SAFE)
-- ----------------------------------------------------------------------------
-- Purpose: replace every direct anon `db.from(<table>).select()` in app.js with
-- a session/capability-authorized SECURITY DEFINER RPC, so that Stage 1 can
-- REVOKE SELECT on companies/workers/workplaces/attendance/audit_log FROM anon.
--
-- This file is STAGE 0 ONLY: it CREATES the read RPCs. It does NOT revoke any
-- grants, so running it changes nothing for existing clients — it is purely
-- additive and reversible (DROP FUNCTION ...). The REVOKEs live in the separate
-- file c2_revoke_anon_reads.sql and MUST NOT be run until the RPC-based frontend
-- is deployed and verified live (same staged discipline as phase2b Section C).
--
-- Conventions (match existing WorkClock RPCs):
--   * SECURITY DEFINER + SET search_path=public  (bypass RLS, no injection)
--   * admin auth via _wc_admin(p_actor_id,p_token) -> admin_users row (or NULL id)
--   * worker auth inline: WHERE id=p_worker_id AND session_token=p_token
--   * reads return jsonb (jsonb_agg / to_jsonb) so the client gets the SAME
--     nested shape its old .select() produced
--   * default PUBLIC EXECUTE; explicit GRANT to anon,authenticated for clarity
--
-- FACE-LOGIN DECISION (2026-07-01): face_login_candidates is scoped to ONE
-- company (p_company_id), shrinking the biometric leak from all tenants to the
-- single company whose code the caller holds. Full server-side face matching
-- remains open issue #5.
-- ============================================================================

BEGIN;

-- ── BUCKET A: connectivity probe (app.js:16) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.public_ping()
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

-- ── BUCKET B: pre-auth login reads (no session yet) ────────────────────────

-- B2. company by code — worker/company login (app.js:296)
CREATE OR REPLACE FUNCTION public.public_company_by_code(p_code text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT to_jsonb(c) FROM (
    SELECT id, name, code, is_active, clock_methods, timezone, worker_limit,
           subscription_expires_at, shift_start, shift_end, shift_grace_min,
           shift_ot_mode, work_days, annual_leave_days, sick_leave_days
    FROM companies
    WHERE upper(code) = upper(p_code) AND is_active = TRUE
    LIMIT 1
  ) c;
$$;

-- B3. non-secret company metadata by id — shift/name/timezone/subscription
--     (app.js:245 loadShift, 646 company name, 2023 subscription, 3077 timezone)
CREATE OR REPLACE FUNCTION public.company_public_info(p_company_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT to_jsonb(c) FROM (
    SELECT id, name, code, is_active, clock_methods, timezone, worker_limit,
           subscription_expires_at, shift_start, shift_end, shift_grace_min,
           shift_ot_mode, work_days, annual_leave_days, sick_leave_days
    FROM companies WHERE id = p_company_id LIMIT 1
  ) c;
$$;

-- Shared helper: minimal worker-login projection (NO pin/face_descriptor/device_id)
-- Returns a jsonb array of active matches, each with a nested `workplace` object
-- matching the old `WORKER_COLS + ', workplace:workplaces(*)'` shape the client reads.
CREATE OR REPLACE FUNCTION public._wc_login_worker_rows(p_company_id uuid, p_employee_id text, p_worker_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'id', w.id, 'employee_id', w.employee_id, 'name', w.name,
      'job_title', w.job_title, 'company_id', w.company_id,
      'workplace_id', w.workplace_id,
      'biometric_enabled', w.biometric_enabled,
      'biometric_credential_id', w.biometric_credential_id,
      'is_active', w.is_active,
      'workplace', CASE WHEN wp.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', wp.id, 'name', wp.name, 'latitude', wp.latitude,
        'longitude', wp.longitude, 'radius_meters', wp.radius_meters,
        'address', wp.address) END
    ) AS row
    FROM workers w
    LEFT JOIN workplaces wp ON wp.id = w.workplace_id
    WHERE w.is_active = TRUE
      AND (p_worker_id   IS NULL OR w.id = p_worker_id)
      AND (p_employee_id IS NULL OR upper(w.employee_id) = upper(p_employee_id))
      AND (p_company_id  IS NULL OR w.company_id = p_company_id)
  ) s;
$$;

-- B4. worker lookup by employee id for the auth screen (app.js:481 findWorker)
--     Returns an ARRAY; client detects 0 / 1 / >1 (the old PGRST116 "multiple").
CREATE OR REPLACE FUNCTION public.public_worker_for_login(p_company_id uuid, p_employee_id text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT public._wc_login_worker_rows(p_company_id, p_employee_id, NULL);
$$;

-- B5. worker lookup by id for the auth screen (app.js:580 homeBiometric, 1587 face resolve)
CREATE OR REPLACE FUNCTION public.public_worker_by_id_for_login(p_worker_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE((public._wc_login_worker_rows(NULL, NULL, p_worker_id) -> 0), 'null'::jsonb);
$$;

-- B6. face-login candidate descriptors — SCOPED TO ONE COMPANY (app.js:1541)
CREATE OR REPLACE FUNCTION public.face_login_candidates(p_company_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', id, 'name', name, 'employee_id', employee_id,
           'face_descriptor', face_descriptor)), '[]'::jsonb)
  FROM workers
  WHERE company_id = p_company_id AND is_active = TRUE AND face_descriptor IS NOT NULL;
$$;

-- ── BUCKET C: worker-session reads (workers.session_token) ──────────────────

-- C1. worker's own attendance history (app.js:1163, 1207)
CREATE OR REPLACE FUNCTION public.worker_my_attendance(p_worker_id uuid, p_token text, p_limit int DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE ok boolean;
BEGIN
  SELECT TRUE INTO ok FROM workers
   WHERE id = p_worker_id AND session_token IS NOT NULL AND session_token = p_token
     AND is_active = TRUE LIMIT 1;
  IF ok IS NOT TRUE THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(a) ORDER BY a.clock_in_time DESC)
    FROM (
      SELECT * FROM attendance
      WHERE worker_id = p_worker_id
      ORDER BY clock_in_time DESC
      LIMIT GREATEST(1, LEAST(p_limit, 1000))
    ) a
  ), '[]'::jsonb);
END; $$;

-- ── BUCKET D: admin-session reads, scoped to the admin's company ────────────

-- D1. workers for the admin's company (p_active: NULL=all / true / false)
--     (app.js:761,1057,2058,2167,2190,2309,2469,2490,2562,2914,3013 + counts)
CREATE OR REPLACE FUNCTION public.admin_list_workers(p_actor_id uuid, p_token text, p_active boolean DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE a admin_users;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', w.id, 'employee_id', w.employee_id, 'name', w.name, 'phone', w.phone,
      'email', w.email, 'workplace_id', w.workplace_id,
      'biometric_credential_id', w.biometric_credential_id,
      'biometric_enabled', w.biometric_enabled, 'is_active', w.is_active,
      'job_title', w.job_title, 'company_id', w.company_id,
      'face_descriptor', w.face_descriptor, 'device_id', w.device_id,
      'failed_attempts', w.failed_attempts, 'locked_until', w.locked_until,
      'force_pin_change', w.force_pin_change,
      'workplace', CASE WHEN wp.id IS NULL THEN NULL ELSE to_jsonb(wp) END
    ) ORDER BY w.name)
    FROM workers w
    LEFT JOIN workplaces wp ON wp.id = w.workplace_id
    WHERE w.company_id = a.company_id
      AND (p_active IS NULL OR w.is_active = p_active)
  ), '[]'::jsonb);
END; $$;

-- D2. attendance for the admin's company, optional date range (app.js:2063,2493,2566)
CREATE OR REPLACE FUNCTION public.admin_list_attendance(p_actor_id uuid, p_token text,
       p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE a admin_users;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(x) ORDER BY x.clock_in_time DESC)
    FROM (
      SELECT at.*, jsonb_build_object('name', w.name, 'employee_id', w.employee_id,
             'job_title', w.job_title) AS w
      FROM attendance at
      JOIN workers w ON w.id = at.worker_id
      WHERE at.company_id = a.company_id
        AND (p_from IS NULL OR at.clock_in_time >= p_from)
        AND (p_to   IS NULL OR at.clock_in_time <  p_to)
    ) x
  ), '[]'::jsonb);
END; $$;

-- D3. audit log for the admin's company (app.js:2170)
CREATE OR REPLACE FUNCTION public.admin_list_audit(p_actor_id uuid, p_token text, p_limit int DEFAULT 150)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE a admin_users;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(l) ORDER BY l.changed_at DESC)
    FROM (
      SELECT * FROM audit_log WHERE company_id = a.company_id
      ORDER BY changed_at DESC LIMIT GREATEST(1, LEAST(p_limit, 1000))
    ) l
  ), '[]'::jsonb);
END; $$;

-- D4. the admin's own company row + active worker count
--     (app.js:2023 sub, 2298/3098 worker_limit, 3077 tz, 3123 sub, setup screens)
CREATE OR REPLACE FUNCTION public.admin_get_company(p_actor_id uuid, p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE a admin_users; res jsonb;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'null'::jsonb; END IF;
  SELECT to_jsonb(c) || jsonb_build_object('active_worker_count', (
           SELECT count(*) FROM workers WHERE company_id = a.company_id AND is_active = TRUE))
    INTO res
  FROM companies c WHERE c.id = a.company_id;
  RETURN COALESCE(res, 'null'::jsonb);
END; $$;

-- D5. workplaces for the admin's company (app.js:3055, 3150)
CREATE OR REPLACE FUNCTION public.admin_list_workplaces(p_actor_id uuid, p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE a admin_users;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(wp) ORDER BY wp.name)
    FROM workplaces wp WHERE wp.company_id = a.company_id
  ), '[]'::jsonb);
END; $$;

-- ── BUCKET E: developer reads (cross-company BY DESIGN) ─────────────────────

-- E1. all companies + active worker count (app.js:3461,3468,3705,3753,3794,3850)
CREATE OR REPLACE FUNCTION public.dev_list_companies(p_actor_id uuid, p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE a admin_users;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL OR a.role <> 'developer' THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object('active_worker_count', (
             SELECT count(*) FROM workers w WHERE w.company_id = c.id AND w.is_active = TRUE))
           ORDER BY c.name)
    FROM companies c
  ), '[]'::jsonb);
END; $$;

-- E2. workers across companies for the dev console (app.js:3804 active, 3852 inactive+co)
CREATE OR REPLACE FUNCTION public.dev_list_workers(p_actor_id uuid, p_token text,
       p_company_id uuid DEFAULT NULL, p_active boolean DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE a admin_users;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL OR a.role <> 'developer' THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', w.id, 'employee_id', w.employee_id, 'name', w.name, 'phone', w.phone,
      'email', w.email, 'workplace_id', w.workplace_id,
      'biometric_credential_id', w.biometric_credential_id,
      'biometric_enabled', w.biometric_enabled, 'is_active', w.is_active,
      'job_title', w.job_title, 'company_id', w.company_id,
      'face_descriptor', w.face_descriptor, 'device_id', w.device_id,
      'failed_attempts', w.failed_attempts, 'locked_until', w.locked_until,
      'force_pin_change', w.force_pin_change,
      'co', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('name', c.name) END
    ) ORDER BY w.name)
    FROM workers w
    LEFT JOIN companies c ON c.id = w.company_id
    WHERE (p_company_id IS NULL OR w.company_id = p_company_id)
      AND (p_active IS NULL OR w.is_active = p_active)
  ), '[]'::jsonb);
END; $$;

-- ── EXECUTE grants (explicit; login RPCs must be callable by anon) ──────────
GRANT EXECUTE ON FUNCTION
  public.public_ping(),
  public.public_company_by_code(text),
  public.company_public_info(uuid),
  public._wc_login_worker_rows(uuid, text, uuid),
  public.public_worker_for_login(uuid, text),
  public.public_worker_by_id_for_login(uuid),
  public.face_login_candidates(uuid),
  public.worker_my_attendance(uuid, text, int),
  public.admin_list_workers(uuid, text, boolean),
  public.admin_list_attendance(uuid, text, timestamptz, timestamptz),
  public.admin_list_audit(uuid, text, int),
  public.admin_get_company(uuid, text),
  public.admin_list_workplaces(uuid, text),
  public.dev_list_companies(uuid, text),
  public.dev_list_workers(uuid, text, uuid, boolean)
TO anon, authenticated;

COMMIT;
