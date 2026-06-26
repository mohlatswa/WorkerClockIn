-- ============================================================
-- WorkClock-In — Payslips (Phase 2)
-- Workers view/download own payslips. Admin: manual PDF upload OR
-- auto-generate (frontend computes from attendance, stored here).
-- Pay rates promoted from on-device localStorage into the DB.
-- All access via SECURITY DEFINER RPCs; no direct anon table access.
-- PDFs are held as base64 and only ever returned through a
-- session-verified RPC for the owning worker / their admin.
-- ============================================================

CREATE TABLE IF NOT EXISTS worker_pay_rates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  worker_id   uuid NOT NULL REFERENCES workers(id),
  hourly_rate numeric NOT NULL DEFAULT 0,
  ot_mult     numeric NOT NULL DEFAULT 1.5,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (worker_id)
);

CREATE TABLE IF NOT EXISTS payslips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  worker_id    uuid NOT NULL REFERENCES workers(id),
  period_label text NOT NULL,
  period_start date,
  period_end   date,
  source       text NOT NULL CHECK (source IN ('upload','auto')),
  gross        numeric,
  reg_hours    numeric,
  ot_hours     numeric,
  rate         numeric,
  ot_mult      numeric,
  paye         numeric,         -- SA income tax (source='auto')
  uif          numeric,         -- employee UIF 1%
  nett         numeric,         -- gross - paye - uif
  tax_year     text,            -- SARS tax year used for the calc, e.g. '2025/26'
  pdf_data     text,            -- base64 (source='upload')
  file_name    text,
  created_by   uuid REFERENCES admin_users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- Backfill the deduction columns onto an already-created payslips table (idempotent).
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS paye     numeric;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS uif      numeric;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS nett     numeric;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS tax_year text;
CREATE INDEX IF NOT EXISTS idx_payslips_worker  ON payslips(worker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payslips_company ON payslips(company_id, created_at DESC);

ALTER TABLE worker_pay_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE payslips         ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON worker_pay_rates FROM anon, authenticated;
REVOKE ALL ON payslips         FROM anon, authenticated;

-- ── WORKER: list my payslips (metadata only — no pdf bytes) ──
CREATE OR REPLACE FUNCTION worker_my_payslips(p_worker_id uuid, p_token text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE w workers%ROWTYPE;
BEGIN
  SELECT * INTO w FROM workers WHERE id = p_worker_id AND session_token = p_token AND is_active = TRUE;
  IF NOT FOUND THEN RETURN json_build_object('error','bad_session'); END IF;
  RETURN COALESCE((SELECT json_agg(x) FROM (
    SELECT id, period_label, period_start, period_end, source, gross, nett, file_name, created_at
      FROM payslips WHERE worker_id = w.id ORDER BY created_at DESC) x), '[]'::json);
END; $$;

-- ── WORKER: fetch one of MY payslips (full, incl pdf/detail) ──
CREATE OR REPLACE FUNCTION worker_get_payslip(p_worker_id uuid, p_token text, p_payslip_id uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE w workers%ROWTYPE; v json;
BEGIN
  SELECT * INTO w FROM workers WHERE id = p_worker_id AND session_token = p_token AND is_active = TRUE;
  IF NOT FOUND THEN RETURN json_build_object('error','bad_session'); END IF;
  SELECT row_to_json(p) INTO v FROM (
    SELECT id, worker_id, period_label, period_start, period_end, source,
           gross, reg_hours, ot_hours, rate, ot_mult, paye, uif, nett, tax_year, pdf_data, file_name, created_at
      FROM payslips WHERE id = p_payslip_id AND worker_id = w.id) p;
  IF v IS NULL THEN RETURN json_build_object('error','not_found'); END IF;
  RETURN v;
END; $$;

-- ── ADMIN: upload a payslip PDF (base64) ──
CREATE OR REPLACE FUNCTION admin_upload_payslip(
  p_actor_id uuid, p_token text, p_worker_id uuid, p_period_label text,
  p_start date, p_end date, p_pdf_data text, p_file_name text, p_gross numeric DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a admin_users%ROWTYPE; v_company uuid;
BEGIN
  a := _wc_actor(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  IF a.company_id IS NULL THEN RETURN 'bad_company'; END IF;
  IF p_pdf_data IS NULL OR length(p_pdf_data) < 10 THEN RETURN 'bad_file'; END IF;
  -- Cap stored size (~5.6MB base64 ≈ 4MB binary) so a direct RPC call can't bloat the table.
  IF length(p_pdf_data) > 5800000 THEN RETURN 'too_large'; END IF;
  IF p_period_label IS NULL OR btrim(p_period_label) = '' THEN RETURN 'bad_period'; END IF;
  SELECT company_id INTO v_company FROM workers WHERE id = p_worker_id;
  IF v_company IS NULL OR v_company <> a.company_id THEN RETURN 'bad_worker'; END IF;
  INSERT INTO payslips(company_id, worker_id, period_label, period_start, period_end, source, gross, pdf_data, file_name, created_by)
  VALUES (a.company_id, p_worker_id, btrim(p_period_label), p_start, p_end, 'upload', p_gross, p_pdf_data, p_file_name, a.id);
  RETURN 'ok';
END; $$;

-- ── ADMIN: save an auto payslip (frontend computed the figures) ──
CREATE OR REPLACE FUNCTION admin_auto_payslip(
  p_actor_id uuid, p_token text, p_worker_id uuid, p_period_label text,
  p_start date, p_end date, p_reg numeric, p_ot numeric, p_rate numeric, p_ot_mult numeric, p_gross numeric,
  p_paye numeric DEFAULT NULL, p_uif numeric DEFAULT NULL, p_nett numeric DEFAULT NULL, p_tax_year text DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a admin_users%ROWTYPE; v_company uuid;
BEGIN
  a := _wc_actor(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  IF a.company_id IS NULL THEN RETURN 'bad_company'; END IF;
  IF p_period_label IS NULL OR btrim(p_period_label) = '' THEN RETURN 'bad_period'; END IF;
  SELECT company_id INTO v_company FROM workers WHERE id = p_worker_id;
  IF v_company IS NULL OR v_company <> a.company_id THEN RETURN 'bad_worker'; END IF;
  INSERT INTO payslips(company_id, worker_id, period_label, period_start, period_end, source,
                       gross, reg_hours, ot_hours, rate, ot_mult, paye, uif, nett, tax_year, created_by)
  VALUES (a.company_id, p_worker_id, btrim(p_period_label), p_start, p_end, 'auto',
          p_gross, p_reg, p_ot, p_rate, p_ot_mult, p_paye, p_uif, p_nett, p_tax_year, a.id);
  RETURN 'ok';
END; $$;

-- ── ADMIN: list company payslips (metadata) ──
CREATE OR REPLACE FUNCTION admin_list_payslips(p_actor_id uuid, p_token text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a admin_users%ROWTYPE;
BEGIN
  a := _wc_actor(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN json_build_object('error','unauthorized'); END IF;
  IF a.company_id IS NULL THEN RETURN json_build_object('error','bad_company'); END IF;
  RETURN COALESCE((SELECT json_agg(x) FROM (
    SELECT ps.id, ps.worker_id, w.name AS worker_name, w.employee_id,
           ps.period_label, ps.source, ps.gross, ps.nett, ps.created_at
      FROM payslips ps JOIN workers w ON w.id = ps.worker_id
     WHERE ps.company_id = a.company_id
     ORDER BY ps.created_at DESC) x), '[]'::json);
END; $$;

-- ── ADMIN: delete a payslip ──
CREATE OR REPLACE FUNCTION admin_delete_payslip(p_actor_id uuid, p_token text, p_payslip_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a admin_users%ROWTYPE; n int;
BEGIN
  a := _wc_actor(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  IF a.company_id IS NULL THEN RETURN 'bad_company'; END IF;
  DELETE FROM payslips WHERE id = p_payslip_id AND company_id = a.company_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN 'not_found'; END IF;
  RETURN 'ok';
END; $$;

-- ── ADMIN: set / get worker pay rates (promote from on-device) ──
CREATE OR REPLACE FUNCTION admin_set_worker_rate(
  p_actor_id uuid, p_token text, p_worker_id uuid, p_rate numeric, p_ot_mult numeric
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a admin_users%ROWTYPE; v_company uuid;
BEGIN
  a := _wc_actor(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN 'unauthorized'; END IF;
  IF a.company_id IS NULL THEN RETURN 'bad_company'; END IF;
  SELECT company_id INTO v_company FROM workers WHERE id = p_worker_id;
  IF v_company IS NULL OR v_company <> a.company_id THEN RETURN 'bad_worker'; END IF;
  INSERT INTO worker_pay_rates(company_id, worker_id, hourly_rate, ot_mult)
  VALUES (a.company_id, p_worker_id, COALESCE(p_rate,0), COALESCE(p_ot_mult,1.5))
  ON CONFLICT (worker_id) DO UPDATE SET hourly_rate = EXCLUDED.hourly_rate, ot_mult = EXCLUDED.ot_mult, updated_at = now();
  RETURN 'ok';
END; $$;

CREATE OR REPLACE FUNCTION admin_get_rates(p_actor_id uuid, p_token text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a admin_users%ROWTYPE;
BEGIN
  a := _wc_actor(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN json_build_object('error','unauthorized'); END IF;
  IF a.company_id IS NULL THEN RETURN json_build_object('error','bad_company'); END IF;
  RETURN COALESCE((SELECT json_agg(x) FROM (
    SELECT worker_id, hourly_rate, ot_mult FROM worker_pay_rates WHERE company_id = a.company_id) x), '[]'::json);
END; $$;
