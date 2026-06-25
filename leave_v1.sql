-- ============================================================
-- WorkClock-In — Leave management (Phase 1)
-- Requests + approvals + balances. Scoped per company.
-- All access via SECURITY DEFINER RPCs (no direct anon table access),
-- matching the existing worker_* / _wc_actor session-auth model.
-- Safe/additive: only adds new objects + 2 company columns.
-- ============================================================

-- ── Company leave policy defaults (BCEA-ish starting points) ──
ALTER TABLE companies ADD COLUMN IF NOT EXISTS annual_leave_days numeric NOT NULL DEFAULT 15;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sick_leave_days   numeric NOT NULL DEFAULT 30;

-- ── leave_requests ──
CREATE TABLE IF NOT EXISTS leave_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  worker_id   uuid NOT NULL REFERENCES workers(id),
  leave_type  text NOT NULL CHECK (leave_type IN ('annual','sick','family','unpaid')),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  days        numeric NOT NULL CHECK (days > 0),
  reason      text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','cancelled')),
  reviewed_by uuid REFERENCES admin_users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leave_req_company_status ON leave_requests(company_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_req_worker        ON leave_requests(worker_id, created_at DESC);

-- ── leave_balances ──
CREATE TABLE IF NOT EXISTS leave_balances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  worker_id    uuid NOT NULL REFERENCES workers(id),
  leave_type   text NOT NULL CHECK (leave_type IN ('annual','sick','family','unpaid')),
  balance_days numeric NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (worker_id, leave_type)
);

-- ── Lock down: no direct anon/authenticated access; everything via RPC ──
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_balances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leave_requests FROM anon, authenticated;
REVOKE ALL ON leave_balances FROM anon, authenticated;

-- ============================================================
-- WORKER RPCs (authorise via workers.session_token)
-- ============================================================

CREATE OR REPLACE FUNCTION worker_apply_leave(
  p_worker_id uuid, p_token text, p_leave_type text,
  p_start date, p_end date, p_reason text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE w workers%ROWTYPE; v_days numeric;
BEGIN
  SELECT * INTO w FROM workers WHERE id = p_worker_id AND session_token = p_token AND is_active = TRUE;
  IF NOT FOUND THEN RETURN 'bad_session'; END IF;
  IF p_leave_type NOT IN ('annual','sick','family','unpaid') THEN RETURN 'bad_type'; END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN RETURN 'bad_dates'; END IF;
  v_days := (p_end - p_start) + 1;
  INSERT INTO leave_requests(company_id, worker_id, leave_type, start_date, end_date, days, reason)
  VALUES (w.company_id, w.id, p_leave_type, p_start, p_end, v_days, NULLIF(btrim(COALESCE(p_reason,'')), ''));
  RETURN 'ok';
END; $$;

CREATE OR REPLACE FUNCTION worker_my_leave(p_worker_id uuid, p_token text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE w workers%ROWTYPE; v_reqs json; v_bal json;
BEGIN
  SELECT * INTO w FROM workers WHERE id = p_worker_id AND session_token = p_token AND is_active = TRUE;
  IF NOT FOUND THEN RETURN json_build_object('error','bad_session'); END IF;
  SELECT COALESCE((SELECT json_agg(x) FROM (
            SELECT id, leave_type, start_date, end_date, days, reason, status, review_note, created_at, reviewed_at
              FROM leave_requests WHERE worker_id = w.id ORDER BY created_at DESC) x), '[]'::json) INTO v_reqs;
  SELECT COALESCE((SELECT json_agg(b) FROM (
            SELECT leave_type, balance_days FROM leave_balances WHERE worker_id = w.id) b), '[]'::json) INTO v_bal;
  RETURN json_build_object('requests', v_reqs, 'balances', v_bal);
END; $$;

CREATE OR REPLACE FUNCTION worker_cancel_leave(p_worker_id uuid, p_token text, p_request_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE w workers%ROWTYPE; n int;
BEGIN
  SELECT * INTO w FROM workers WHERE id = p_worker_id AND session_token = p_token AND is_active = TRUE;
  IF NOT FOUND THEN RETURN 'bad_session'; END IF;
  UPDATE leave_requests SET status = 'cancelled'
   WHERE id = p_request_id AND worker_id = w.id AND status = 'pending';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN 'not_pending'; END IF;
  RETURN 'ok';
END; $$;

-- ============================================================
-- ADMIN RPCs (authorise via _wc_actor, scoped to company)
-- ============================================================

CREATE OR REPLACE FUNCTION admin_leave_list(p_actor_id uuid, p_token text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a admin_users%ROWTYPE;
BEGIN
  a := _wc_actor(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN json_build_object('error','unauthorized'); END IF;
  IF a.company_id IS NULL THEN RETURN json_build_object('error','bad_company'); END IF;
  RETURN COALESCE((SELECT json_agg(x) FROM (
    SELECT lr.id, lr.worker_id, w.name AS worker_name, w.employee_id,
           lr.leave_type, lr.start_date, lr.end_date, lr.days, lr.reason,
           lr.status, lr.review_note, lr.created_at, lr.reviewed_at
      FROM leave_requests lr JOIN workers w ON w.id = lr.worker_id
     WHERE lr.company_id = a.company_id
     ORDER BY (lr.status = 'pending') DESC, lr.created_at DESC) x), '[]'::json);
END; $$;

CREATE OR REPLACE FUNCTION admin_review_leave(
  p_actor_id uuid, p_token text, p_request_id uuid, p_decision text, p_note text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a admin_users%ROWTYPE; r leave_requests%ROWTYPE;
BEGIN
  a := _wc_actor(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  IF a.company_id IS NULL THEN RETURN 'bad_company'; END IF;
  IF p_decision NOT IN ('approved','declined') THEN RETURN 'bad_decision'; END IF;
  SELECT * INTO r FROM leave_requests WHERE id = p_request_id AND company_id = a.company_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF r.status <> 'pending' THEN RETURN 'already_reviewed'; END IF;
  UPDATE leave_requests
     SET status = p_decision, reviewed_by = a.id, reviewed_at = now(),
         review_note = NULLIF(btrim(COALESCE(p_note,'')), '')
   WHERE id = r.id;
  -- deduct balance on approval (only if a balance row exists; never auto-creates)
  IF p_decision = 'approved' AND r.leave_type IN ('annual','sick','family') THEN
    UPDATE leave_balances SET balance_days = balance_days - r.days, updated_at = now()
     WHERE worker_id = r.worker_id AND leave_type = r.leave_type;
  END IF;
  RETURN 'ok';
END; $$;

CREATE OR REPLACE FUNCTION admin_set_leave_balance(
  p_actor_id uuid, p_token text, p_worker_id uuid, p_leave_type text, p_days numeric
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a admin_users%ROWTYPE; v_company uuid;
BEGIN
  a := _wc_actor(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  IF a.company_id IS NULL THEN RETURN 'bad_company'; END IF;
  IF p_leave_type NOT IN ('annual','sick','family','unpaid') THEN RETURN 'bad_type'; END IF;
  SELECT company_id INTO v_company FROM workers WHERE id = p_worker_id;
  IF v_company IS NULL OR v_company <> a.company_id THEN RETURN 'bad_worker'; END IF;
  INSERT INTO leave_balances(company_id, worker_id, leave_type, balance_days)
  VALUES (a.company_id, p_worker_id, p_leave_type, p_days)
  ON CONFLICT (worker_id, leave_type) DO UPDATE SET balance_days = EXCLUDED.balance_days, updated_at = now();
  RETURN 'ok';
END; $$;
