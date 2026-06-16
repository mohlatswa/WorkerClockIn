-- ============================================================
--  WorkClock — Phase 2b: admin/worker/workplace write RPCs
--  DRAFT for review. Run in the Supabase SQL editor.
--
--  This is the prerequisite for the workers/workplaces REVOKEs in
--  phase2b_worker_clock_rpc.sql (Section C). It moves every remaining
--  write to workers + workplaces behind a SECURITY DEFINER RPC that
--  verifies the caller's session token + role + company, mirroring
--  the existing admin_manage_* / admin_self_* / dev_company_* RPCs.
--
--  Contract (matches the existing RPCs + the rpcOk() helper):
--    inputs : p_actor_id (admin id) + p_token (admin session_token)
--    returns: TEXT  'ok' | 'unauthorized' | 'dupe' | 'not_found'
--                  | 'limit'          (worker limit reached)
--             admin_worker_create returns the NEW WORKER UUID on
--             success (or one of the error codes above).
--
--  Run order: this file is ADDITIVE and safe to run now. Apply it,
--  deploy the matching frontend, verify admin worker/workplace
--  management still works, THEN run Section C of the clock-RPC file.
-- ============================================================


-- ════════════════════════════════════════════════════════════
--  SECTION 0 — schema reconciliation (verify against production)
--
--  aTok() sends S.admin.session_token and admin_login_v2 issues it,
--  so admin_users.session_token must exist live — but schema.sql does
--  not list it. This idempotent guard guarantees it before the RPCs
--  below rely on it. (Reconcile schema.sql separately.)
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.admin_users
  ADD COLUMN IF NOT EXISTS session_token TEXT;


-- ════════════════════════════════════════════════════════════
--  SECTION 1 — actor validator (internal; not anon-callable)
--
--  Returns the admin row when the token matches an active, unlocked
--  admin; NULL row otherwise. SECURITY DEFINER callers below can use
--  it even though anon cannot call it directly (same hardening the
--  audit applied to _wc_actor).
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._wc_admin(p_actor_id UUID, p_token TEXT)
RETURNS admin_users
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM admin_users
   WHERE id = p_actor_id
     AND session_token IS NOT NULL
     AND session_token = p_token
     AND is_active = TRUE
     AND (locked_until IS NULL OR locked_until < NOW())
   LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public._wc_admin(UUID, TEXT) FROM PUBLIC, anon, authenticated;


-- ════════════════════════════════════════════════════════════
--  SECTION 2 — WORKER write RPCs
-- ════════════════════════════════════════════════════════════

-- 2a. Create a worker (enforces the company worker_limit server-side).
CREATE OR REPLACE FUNCTION public.admin_worker_create(
  p_actor_id UUID, p_token TEXT,
  p_company_id UUID, p_employee_id TEXT, p_name TEXT,
  p_job_title TEXT, p_pin_hash TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a       admin_users;
  v_limit INTEGER;
  v_count INTEGER;
  v_wp    UUID;
  v_id    UUID;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  IF a.role <> 'developer' AND a.company_id <> p_company_id THEN RETURN 'unauthorized'; END IF;

  SELECT worker_limit INTO v_limit FROM companies WHERE id = p_company_id;
  IF v_limit IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM workers
     WHERE company_id = p_company_id AND is_active = TRUE;
    IF v_count >= v_limit THEN RETURN 'limit'; END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM workers
              WHERE company_id = p_company_id AND employee_id = p_employee_id) THEN
    RETURN 'dupe';
  END IF;

  -- default the worker onto the company's single workplace, if any
  SELECT id INTO v_wp FROM workplaces WHERE company_id = p_company_id LIMIT 1;

  INSERT INTO workers (company_id, workplace_id, employee_id, name, job_title,
                       pin, force_pin_change, is_active)
  VALUES (p_company_id, v_wp, p_employee_id, p_name, NULLIF(p_job_title,''),
          p_pin_hash, TRUE, TRUE)
  RETURNING id INTO v_id;

  RETURN v_id::text;   -- success = the new worker's UUID
END;
$$;

-- 2b. Update a worker's details (PIN optional: NULL = leave unchanged).
CREATE OR REPLACE FUNCTION public.admin_worker_update(
  p_actor_id UUID, p_token TEXT, p_id UUID,
  p_employee_id TEXT, p_name TEXT, p_job_title TEXT, p_pin_hash TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a admin_users; v_co UUID;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  SELECT company_id INTO v_co FROM workers WHERE id = p_id;
  IF v_co IS NULL THEN RETURN 'not_found'; END IF;
  IF a.role <> 'developer' AND a.company_id <> v_co THEN RETURN 'unauthorized'; END IF;

  IF EXISTS (SELECT 1 FROM workers
              WHERE company_id = v_co AND employee_id = p_employee_id AND id <> p_id) THEN
    RETURN 'dupe';
  END IF;

  UPDATE workers SET
    employee_id = p_employee_id,
    name        = p_name,
    job_title   = NULLIF(p_job_title,''),
    pin              = COALESCE(p_pin_hash, pin),
    force_pin_change = CASE WHEN p_pin_hash IS NULL THEN force_pin_change ELSE FALSE END,
    updated_at  = NOW()
  WHERE id = p_id;
  RETURN 'ok';
END;
$$;

-- 2c. Activate / deactivate (covers admin + dev toggle + restore).
CREATE OR REPLACE FUNCTION public.admin_worker_toggle(
  p_actor_id UUID, p_token TEXT, p_id UUID, p_active BOOLEAN
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a admin_users; v_co UUID;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  SELECT company_id INTO v_co FROM workers WHERE id = p_id;
  IF v_co IS NULL THEN RETURN 'not_found'; END IF;
  IF a.role <> 'developer' AND a.company_id <> v_co THEN RETURN 'unauthorized'; END IF;
  UPDATE workers SET is_active = p_active, updated_at = NOW() WHERE id = p_id;
  RETURN 'ok';
END;
$$;

-- 2d. Reset security (clear device binding, session, lockout).
CREATE OR REPLACE FUNCTION public.admin_worker_reset_security(
  p_actor_id UUID, p_token TEXT, p_id UUID
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a admin_users; v_co UUID;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  SELECT company_id INTO v_co FROM workers WHERE id = p_id;
  IF v_co IS NULL THEN RETURN 'not_found'; END IF;
  IF a.role <> 'developer' AND a.company_id <> v_co THEN RETURN 'unauthorized'; END IF;
  UPDATE workers SET device_id = NULL, session_token = NULL,
                     failed_attempts = 0, locked_until = NULL, updated_at = NOW()
   WHERE id = p_id;
  RETURN 'ok';
END;
$$;

-- 2e. Set a worker's enrolled face descriptor (admin face enrolment).
CREATE OR REPLACE FUNCTION public.admin_worker_set_face(
  p_actor_id UUID, p_token TEXT, p_id UUID, p_descriptor TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a admin_users; v_co UUID;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  SELECT company_id INTO v_co FROM workers WHERE id = p_id;
  IF v_co IS NULL THEN RETURN 'not_found'; END IF;
  IF a.role <> 'developer' AND a.company_id <> v_co THEN RETURN 'unauthorized'; END IF;
  UPDATE workers SET face_descriptor = p_descriptor,
                     biometric_consent_at = COALESCE(biometric_consent_at, NOW()),
                     updated_at = NOW() WHERE id = p_id;
  RETURN 'ok';
END;
$$;

-- 2f. Set a worker's WebAuthn credential (admin-registered biometric).
CREATE OR REPLACE FUNCTION public.admin_worker_set_biometric(
  p_actor_id UUID, p_token TEXT, p_id UUID, p_credential_id TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a admin_users; v_co UUID;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  SELECT company_id INTO v_co FROM workers WHERE id = p_id;
  IF v_co IS NULL THEN RETURN 'not_found'; END IF;
  IF a.role <> 'developer' AND a.company_id <> v_co THEN RETURN 'unauthorized'; END IF;
  UPDATE workers SET biometric_credential_id = p_credential_id,
                     biometric_enabled = TRUE,
                     biometric_consent_at = COALESCE(biometric_consent_at, NOW()),
                     updated_at = NOW()
   WHERE id = p_id;
  RETURN 'ok';
END;
$$;

-- 2g. Withdraw biometric consent: delete the biometric data + consent
--     record (a POPIA data-subject right).
CREATE OR REPLACE FUNCTION public.admin_worker_clear_biometric(
  p_actor_id UUID, p_token TEXT, p_id UUID
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a admin_users; v_co UUID;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  SELECT company_id INTO v_co FROM workers WHERE id = p_id;
  IF v_co IS NULL THEN RETURN 'not_found'; END IF;
  IF a.role <> 'developer' AND a.company_id <> v_co THEN RETURN 'unauthorized'; END IF;
  UPDATE workers SET face_descriptor = NULL, biometric_credential_id = NULL,
                     biometric_enabled = FALSE, biometric_consent_at = NULL,
                     updated_at = NOW()
   WHERE id = p_id;
  RETURN 'ok';
END;
$$;


-- ════════════════════════════════════════════════════════════
--  SECTION 3 — WORKPLACE write RPC (upsert + backfill workers)
-- ════════════════════════════════════════════════════════════

-- p_id NULL → insert a new workplace; otherwise update that one.
-- After save, any worker in the company with NULL workplace_id is
-- attached to it (mirrors the old saveWorkplace() follow-up).
CREATE OR REPLACE FUNCTION public.admin_workplace_save(
  p_actor_id UUID, p_token TEXT, p_company_id UUID, p_id UUID,
  p_name TEXT, p_address TEXT,
  p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION, p_radius INTEGER
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a admin_users; v_id UUID;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  IF a.role <> 'developer' AND a.company_id <> p_company_id THEN RETURN 'unauthorized'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO workplaces (company_id, name, address, latitude, longitude, radius_meters)
    VALUES (p_company_id, p_name, NULLIF(p_address,''), p_lat, p_lng, COALESCE(p_radius,100))
    RETURNING id INTO v_id;
  ELSE
    UPDATE workplaces SET name = p_name, address = NULLIF(p_address,''),
           latitude = p_lat, longitude = p_lng,
           radius_meters = COALESCE(p_radius,100), updated_at = NOW()
     WHERE id = p_id AND company_id = p_company_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RETURN 'not_found'; END IF;
  END IF;

  UPDATE workers SET workplace_id = v_id
   WHERE company_id = p_company_id AND workplace_id IS NULL;
  RETURN 'ok';
END;
$$;


-- 3b. Resolve a missed clock-out: admin sets the real clock-out time.
--     Completes a 'missed' or still-open 'active' attendance row.
CREATE OR REPLACE FUNCTION public.admin_set_attendance_clockout(
  p_actor_id UUID, p_token TEXT, p_id UUID, p_clock_out TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a admin_users; v_co UUID; v_in TIMESTAMPTZ;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  -- fall back to the worker's company for legacy rows with NULL company_id
  SELECT COALESCE(att.company_id, w.company_id), att.clock_in_time
    INTO v_co, v_in
    FROM attendance att JOIN workers w ON w.id = att.worker_id
   WHERE att.id = p_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF a.role <> 'developer' AND a.company_id <> v_co THEN RETURN 'unauthorized'; END IF;
  IF p_clock_out IS NULL OR (v_in IS NOT NULL AND p_clock_out <= v_in) THEN
    RETURN 'bad_time';   -- clock-out must be after clock-in
  END IF;
  UPDATE attendance
     SET clock_out_time = p_clock_out, status = 'completed'
   WHERE id = p_id;
  RETURN 'ok';
END;
$$;


-- ════════════════════════════════════════════════════════════
--  SECTION 4 — WORKER self-service writes (worker session token)
--
--  These let a logged-in worker manage their own row without direct
--  table writes, so the Section C revoke doesn't break them.
-- ════════════════════════════════════════════════════════════

-- 4a. Worker self-registers a WebAuthn credential.
CREATE OR REPLACE FUNCTION public.worker_set_biometric(
  p_worker_id UUID, p_token TEXT, p_credential_id TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w workers;
BEGIN
  SELECT * INTO w FROM workers
   WHERE id = p_worker_id AND is_active = TRUE;
  IF NOT FOUND OR w.session_token IS NULL OR w.session_token <> p_token THEN
    RETURN 'unauthorized';
  END IF;
  UPDATE workers SET biometric_credential_id = p_credential_id, biometric_enabled = TRUE,
                     biometric_consent_at = COALESCE(biometric_consent_at, NOW()),
                     updated_at = NOW()
   WHERE id = p_worker_id;
  RETURN 'ok';
END;
$$;

-- 4a-bis. Worker self-enrols their own face descriptor.
CREATE OR REPLACE FUNCTION public.worker_set_face(
  p_worker_id UUID, p_token TEXT, p_descriptor TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w workers;
BEGIN
  SELECT * INTO w FROM workers
   WHERE id = p_worker_id AND is_active = TRUE;
  IF NOT FOUND OR w.session_token IS NULL OR w.session_token <> p_token THEN
    RETURN 'unauthorized';
  END IF;
  UPDATE workers SET face_descriptor = p_descriptor,
                     biometric_consent_at = COALESCE(biometric_consent_at, NOW()),
                     updated_at = NOW()
   WHERE id = p_worker_id;
  RETURN 'ok';
END;
$$;

-- 4b. Biometric login: issues a session token after a platform-auth
--     assertion (device binding enforced; mirrors worker_login's
--     success path minus the PIN-hash check).
CREATE OR REPLACE FUNCTION public.worker_biometric_login(
  p_worker_id UUID, p_device_id TEXT, p_new_token TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w workers;
BEGIN
  SELECT * INTO w FROM workers
   WHERE id = p_worker_id AND is_active = TRUE AND biometric_enabled = TRUE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF w.device_id IS NOT NULL AND w.device_id <> p_device_id THEN
    RETURN 'wrong_device';
  END IF;
  UPDATE workers SET session_token = p_new_token,
                     device_id = COALESCE(device_id, p_device_id),
                     failed_attempts = 0, locked_until = NULL, updated_at = NOW()
   WHERE id = p_worker_id;
  RETURN 'ok';
END;
$$;

-- 4c. Worker logout: clears their own session token.
CREATE OR REPLACE FUNCTION public.worker_logout(
  p_worker_id UUID, p_token TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE workers SET session_token = NULL
   WHERE id = p_worker_id AND session_token = p_token;
  RETURN 'ok';
END;
$$;


-- ════════════════════════════════════════════════════════════
--  SECTION 5 — grants
--
--  anon may EXECUTE these RPCs (each self-authorises via the token);
--  it does NOT get direct table writes once Section C is applied.
-- ════════════════════════════════════════════════════════════
GRANT EXECUTE ON FUNCTION
  public.admin_worker_create(UUID,TEXT,UUID,TEXT,TEXT,TEXT,TEXT),
  public.admin_worker_update(UUID,TEXT,UUID,TEXT,TEXT,TEXT,TEXT),
  public.admin_worker_toggle(UUID,TEXT,UUID,BOOLEAN),
  public.admin_worker_reset_security(UUID,TEXT,UUID),
  public.admin_worker_set_face(UUID,TEXT,UUID,TEXT),
  public.admin_worker_set_biometric(UUID,TEXT,UUID,TEXT),
  public.admin_worker_clear_biometric(UUID,TEXT,UUID),
  public.admin_workplace_save(UUID,TEXT,UUID,UUID,TEXT,TEXT,DOUBLE PRECISION,DOUBLE PRECISION,INTEGER),
  public.admin_set_attendance_clockout(UUID,TEXT,UUID,TIMESTAMPTZ),
  public.worker_set_biometric(UUID,TEXT,TEXT),
  public.worker_set_face(UUID,TEXT,TEXT),
  public.worker_biometric_login(UUID,TEXT,TEXT),
  public.worker_logout(UUID,TEXT)
TO anon, authenticated;

-- After deploying the matching frontend and confirming admin worker/
-- workplace management + worker biometric still work, run Section C
-- of phase2b_worker_clock_rpc.sql to revoke direct writes.
