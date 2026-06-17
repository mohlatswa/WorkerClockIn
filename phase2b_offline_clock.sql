-- ============================================================
--  WorkClock — offline clock-in support
--  Run in the Supabase SQL editor (after the earlier Phase 2b SQL).
--
--  Adds an optional p_at timestamp to worker_clock_action so a clock
--  action saved OFFLINE keeps the real time it happened (synced later),
--  instead of the sync time. Online calls pass NULL → server uses NOW().
--  Old 7-arg signature is dropped so only one exists.
-- ============================================================

DROP FUNCTION IF EXISTS public.worker_clock_action(
  UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.worker_clock_action(
  p_worker_id   UUID,
  p_token       TEXT,
  p_action      TEXT,
  p_lat         DOUBLE PRECISION DEFAULT NULL,
  p_lng         DOUBLE PRECISION DEFAULT NULL,
  p_auth_method TEXT DEFAULT 'pin',
  p_device_label TEXT DEFAULT NULL,
  p_at          TIMESTAMPTZ DEFAULT NULL
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
  R           CONSTANT DOUBLE PRECISION := 6371000;
  dlat        DOUBLE PRECISION;
  dlng        DOUBLE PRECISION;
  a           DOUBLE PRECISION;
BEGIN
  SELECT * INTO w FROM workers
   WHERE id = p_worker_id AND is_active = TRUE;
  IF NOT FOUND OR w.session_token IS NULL OR w.session_token <> p_token THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_session');
  END IF;

  SELECT * INTO c FROM companies WHERE id = w.company_id;
  IF NOT FOUND OR c.is_active <> TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'inactive');
  END IF;
  IF c.subscription_expires_at IS NOT NULL
     AND c.subscription_expires_at < NOW() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;

  IF p_action = 'in' THEN
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

    UPDATE attendance
       SET status = 'missed'
     WHERE worker_id = w.id AND status = 'active';

    INSERT INTO attendance (worker_id, company_id, workplace_id,
                            clock_in_time, clock_in_latitude,
                            clock_in_longitude, auth_method, device_label, status)
    VALUES (w.id, w.company_id, w.workplace_id, COALESCE(p_at, NOW()), p_lat, p_lng,
            COALESCE(p_auth_method, 'pin'), p_device_label, 'active')
    RETURNING id INTO v_att_id;

    RETURN jsonb_build_object('ok', true, 'action', 'in',
                              'attendance_id', v_att_id);

  ELSIF p_action = 'out' THEN
    UPDATE attendance
       SET clock_out_time = COALESCE(p_at, NOW()), status = 'completed',
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

GRANT EXECUTE ON FUNCTION public.worker_clock_action(UUID, TEXT, TEXT,
  DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TIMESTAMPTZ) TO anon, authenticated;
