-- ============================================================
--  WorkClock — POPIA biometric consent
--  Run in the Supabase SQL editor (additive; safe). Run AFTER
--  phase2b_admin_worker_workplace_rpcs.sql.
--
--  • Adds workers.biometric_consent_at — stamped the first time a
--    worker's face/fingerprint is enrolled (the UI shows the consent
--    notice + checkbox before calling these RPCs).
--  • Adds admin_worker_clear_biometric — withdrawal: deletes the
--    biometric data and the consent record (a POPIA data-subject right).
--  All four enrolment RPCs keep the SAME signature, so CREATE OR REPLACE
--  cleanly replaces them — no DROP needed.
-- ============================================================

ALTER TABLE public.workers ADD COLUMN IF NOT EXISTS biometric_consent_at TIMESTAMPTZ;

-- ── enrolment RPCs: also record first-consent timestamp ──

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
                     updated_at = NOW()
   WHERE id = p_id;
  RETURN 'ok';
END;
$$;

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
  UPDATE workers SET biometric_credential_id = p_credential_id, biometric_enabled = TRUE,
                     biometric_consent_at = COALESCE(biometric_consent_at, NOW()),
                     updated_at = NOW()
   WHERE id = p_id;
  RETURN 'ok';
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_set_biometric(
  p_worker_id UUID, p_token TEXT, p_credential_id TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w workers;
BEGIN
  SELECT * INTO w FROM workers WHERE id = p_worker_id AND is_active = TRUE;
  IF NOT FOUND OR w.session_token IS NULL OR w.session_token <> p_token THEN RETURN 'unauthorized'; END IF;
  UPDATE workers SET biometric_credential_id = p_credential_id, biometric_enabled = TRUE,
                     biometric_consent_at = COALESCE(biometric_consent_at, NOW()),
                     updated_at = NOW()
   WHERE id = p_worker_id;
  RETURN 'ok';
END;
$$;

CREATE OR REPLACE FUNCTION public.worker_set_face(
  p_worker_id UUID, p_token TEXT, p_descriptor TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w workers;
BEGIN
  SELECT * INTO w FROM workers WHERE id = p_worker_id AND is_active = TRUE;
  IF NOT FOUND OR w.session_token IS NULL OR w.session_token <> p_token THEN RETURN 'unauthorized'; END IF;
  UPDATE workers SET face_descriptor = p_descriptor,
                     biometric_consent_at = COALESCE(biometric_consent_at, NOW()),
                     updated_at = NOW()
   WHERE id = p_worker_id;
  RETURN 'ok';
END;
$$;

-- ── withdrawal: delete biometric data + consent record ──
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

GRANT EXECUTE ON FUNCTION public.admin_worker_clear_biometric(UUID, TEXT, UUID)
  TO anon, authenticated;
