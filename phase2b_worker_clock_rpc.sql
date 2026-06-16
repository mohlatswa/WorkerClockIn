-- ============================================================
--  WorkClock — Phase 2b: server-side clock-in + write lockdown
--  DRAFT for review. Run in the Supabase SQL editor.
--
--  Goal: make attendance a TRUSTWORTHY record. Today the anon key
--  (shipped in config.js) can insert/alter/delete attendance, reset
--  worker PINs, rebind devices and move geofences directly. This
--  routes the clock-in path through a SECURITY DEFINER RPC that
--  validates everything SERVER-SIDE, so the final REVOKEs at the
--  bottom can be applied without trusting the browser.
--
--  ORDER OF OPERATIONS (important):
--    1. Run sections A + B now (adds the RPC; safe, additive).
--    2. Migrate the 3 frontend clock-in paths to call the RPC
--       (app.js clockAction, clockin.html, worker.html).
--    3. Migrate admin worker/workplace writes to RPCs (separate task).
--    4. ONLY THEN run section C (the REVOKEs). Running C early
--       breaks every direct-write path that hasn't been migrated.
-- ============================================================


-- ════════════════════════════════════════════════════════════
--  SECTION A — schema reconciliation (verify against production)
--
--  schema.sql does NOT list attendance.company_id, yet clockin.html
--  and worker.html already INSERT it, and worker.html sends
--  auth_method='portal' which the documented CHECK forbids. Either
--  production already drifted or those paths are silently failing.
--  These statements are idempotent — safe to run to GUARANTEE the
--  column + allowed values exist before the RPC relies on them.
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_attendance_company ON public.attendance(company_id);

-- Backfill company_id on existing rows (the old app.js clock-in path
-- never set it) from the worker's company.
UPDATE public.attendance att
   SET company_id = w.company_id
  FROM public.workers w
 WHERE att.worker_id = w.id AND att.company_id IS NULL;

-- Widen the auth_method allow-list to include the values the app sends.
ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS attendance_auth_method_check;
ALTER TABLE public.attendance
  ADD CONSTRAINT attendance_auth_method_check
  CHECK (auth_method IS NULL OR auth_method IN
         ('pin','biometric','qr','nfc','face','portal'));

-- Add the 'missed' status: a session a worker never clocked out of.
-- clock_out_time stays NULL until an admin sets the real time.
ALTER TABLE public.attendance DROP CONSTRAINT IF EXISTS attendance_status_check;
ALTER TABLE public.attendance
  ADD CONSTRAINT attendance_status_check
  CHECK (status IN ('active','completed','missed'));

-- Human-readable sign-in device captured by the browser at clock-in.
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS device_label TEXT;


-- ════════════════════════════════════════════════════════════
--  SECTION B — the server-side clock RPC
--
--  Validates, in order:
--    • the worker exists, is active, and the session token matches
--    • the company is active AND not past subscription_expires_at
--    • (clock IN) the worker is inside the workplace geofence, when
--      the workplace has coordinates — distance computed here, NOT
--      trusted from the client
--  Then performs the insert/update atomically and returns JSON.
--
--  Returns one of:
--    { ok:true, action:'in',  attendance_id:<uuid> }
--    { ok:true, action:'out', attendance_id:<uuid> }
--    { ok:false, error:'bad_session' | 'inactive' | 'expired'
--                       | 'too_far' | 'no_open_session' | 'bad_action' }
-- ════════════════════════════════════════════════════════════

-- Drop the earlier 6-arg version so only one (7-arg) signature exists —
-- PostgREST does not handle overloaded RPCs well.
DROP FUNCTION IF EXISTS public.worker_clock_action(
  UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT);

CREATE OR REPLACE FUNCTION public.worker_clock_action(
  p_worker_id   UUID,
  p_token       TEXT,
  p_action      TEXT,            -- 'in' | 'out'
  p_lat         DOUBLE PRECISION DEFAULT NULL,
  p_lng         DOUBLE PRECISION DEFAULT NULL,
  p_auth_method TEXT DEFAULT 'pin',
  p_device_label TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w           workers%ROWTYPE;
  c           companies%ROWTYPE;
  wp          workplaces%ROWTYPE;
  v_dist      DOUBLE PRECISION;
  v_radius    INTEGER;
  v_att_id    UUID;
  R           CONSTANT DOUBLE PRECISION := 6371000;  -- earth radius (m)
  dlat        DOUBLE PRECISION;
  dlng        DOUBLE PRECISION;
  a           DOUBLE PRECISION;
BEGIN
  -- 1. authenticate the worker via session token --------------
  SELECT * INTO w FROM workers
   WHERE id = p_worker_id AND is_active = TRUE;
  IF NOT FOUND OR w.session_token IS NULL OR w.session_token <> p_token THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_session');
  END IF;

  -- 2. company must be active and not expired -----------------
  SELECT * INTO c FROM companies WHERE id = w.company_id;
  IF NOT FOUND OR c.is_active <> TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'inactive');
  END IF;
  IF c.subscription_expires_at IS NOT NULL
     AND c.subscription_expires_at < NOW() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;

  IF p_action = 'in' THEN
    -- 3. server-side geofence (only if workplace has coordinates)
    IF w.workplace_id IS NOT NULL THEN
      SELECT * INTO wp FROM workplaces WHERE id = w.workplace_id;
      IF FOUND AND wp.latitude IS NOT NULL AND wp.longitude IS NOT NULL
         AND p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
        v_radius := COALESCE(wp.radius_meters, 100);
        dlat := radians(p_lat - wp.latitude);
        dlng := radians(p_lng - wp.longitude);
        a := sin(dlat/2)^2
             + cos(radians(wp.latitude)) * cos(radians(p_lat)) * sin(dlng/2)^2;
        v_dist := R * 2 * atan2(sqrt(a), sqrt(1-a));
        IF v_dist > v_radius THEN
          RETURN jsonb_build_object('ok', false, 'error', 'too_far',
                                    'distance', round(v_dist)::int,
                                    'radius', v_radius);
        END IF;
      END IF;
    END IF;

    -- 4. A worker can't be clocked in twice. Any session still 'active'
    --    when they clock in again is a forgotten clock-out: flag it
    --    'missed' for admin review — NEVER fabricate a clock-out time
    --    (clock_out_time stays NULL). An admin sets the real time via
    --    admin_set_attendance_clockout.
    UPDATE attendance
       SET status = 'missed'
     WHERE worker_id = w.id AND status = 'active';

    INSERT INTO attendance (worker_id, company_id, workplace_id,
                            clock_in_time, clock_in_latitude,
                            clock_in_longitude, auth_method, device_label, status)
    VALUES (w.id, w.company_id, w.workplace_id, NOW(), p_lat, p_lng,
            COALESCE(p_auth_method, 'pin'), p_device_label, 'active')
    RETURNING id INTO v_att_id;

    RETURN jsonb_build_object('ok', true, 'action', 'in',
                              'attendance_id', v_att_id);

  ELSIF p_action = 'out' THEN
    UPDATE attendance
       SET clock_out_time = NOW(), status = 'completed',
           clock_out_latitude = p_lat, clock_out_longitude = p_lng
     WHERE id = (SELECT id FROM attendance
                  WHERE worker_id = w.id AND status = 'active'
                  ORDER BY clock_in_time DESC LIMIT 1)
    RETURNING id INTO v_att_id;

    IF v_att_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_open_session');
    END IF;
    RETURN jsonb_build_object('ok', true, 'action', 'out',
                              'attendance_id', v_att_id);
  END IF;

  RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
END;
$$;

-- anon may EXECUTE the RPC (it self-authorises via the token);
-- it does NOT get direct table writes once Section C is applied.
GRANT EXECUTE ON FUNCTION public.worker_clock_action(UUID, TEXT, TEXT,
  DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT) TO anon, authenticated;


-- ════════════════════════════════════════════════════════════
--  SECTION C — THE LOCKDOWN  ⚠️ DO NOT RUN YET
--
--  Apply ONLY after all three clock-in paths call the RPC above
--  AND admin worker/workplace management has its own RPCs. Until
--  then these REVOKEs will break legitimate writes.
--
--  Pre-flight checklist before running:
--    [x] app.js clockAction() calls db.rpc('worker_clock_action', …)
--    [x] clockin.html / worker.html  -> DELETED (legacy, not used)
--    [x] admin add/edit/toggle worker -> admin_worker_*  (see
--        phase2b_admin_worker_workplace_rpcs.sql)
--    [x] admin add/edit workplace     -> admin_workplace_save
--    [x] worker security reset / face / biometric / logout / bio-login
--        -> admin_worker_* + worker_* RPCs
--    [ ] phase2b_admin_worker_workplace_rpcs.sql has been RUN in Supabase
--    [ ] new frontend deployed and admin worker/workplace mgmt verified live
-- ════════════════════════════════════════════════════════════

-- REVOKE INSERT, UPDATE, DELETE ON public.attendance  FROM anon, authenticated;
-- REVOKE INSERT, UPDATE, DELETE ON public.workers     FROM anon, authenticated;
-- REVOKE INSERT, UPDATE, DELETE ON public.workplaces  FROM anon, authenticated;

-- Verify after running (each should error with 42501 from the anon key):
--   INSERT INTO attendance(worker_id,status) VALUES (gen_random_uuid(),'active');


-- ════════════════════════════════════════════════════════════
--  OVERNIGHT / FORGOTTEN CLOCK-OUTS (audit item #3 — POLICY CHOSEN)
--
--  Policy: "flag for admin review" — the system never fabricates a
--  clock-out time. A session a worker never closed becomes status
--  'missed' (clock_out_time NULL) and is surfaced to the admin, who
--  sets the real time via admin_set_attendance_clockout (see
--  phase2b_admin_worker_workplace_rpcs.sql). Records needing review =
--    status = 'missed'
--    OR (status = 'active' AND clock_in_time < start-of-today)   -- still
--       open from a prior day even if the worker hasn't returned yet.
--  'missed'/open rows contribute 0 hours until completed, so payroll
--  is never inflated by a guess.
-- ════════════════════════════════════════════════════════════
