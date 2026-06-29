-- ============================================================
-- WorkClock-In — admin-list read RPCs
-- Fixes the "manage admins" screens that broke when admin_users was
-- locked down: the frontend listed admins via a direct anon
-- db.from('admin_users').select(...), but admin_users has RLS enabled
-- with NO select policy, so anon gets ZERO rows — the screens always
-- showed "No admins yet". These session-verified SECURITY DEFINER RPCs
-- return the same data the broken selects intended, scoped server-side.
--
-- Auth pattern matches the rest of the app: anon-callable but
-- self-authorizing via _wc_admin(actor_id, token) (relies on the default
-- PUBLIC EXECUTE grant, same as leave_v1 / payslips_v1 RPCs).
-- Run this in the Supabase SQL editor.
-- ============================================================

-- 1) Admins of the CALLER'S OWN company (active + inactive), excluding
--    developer accounts. Used by loadCoAdmins() + loadAdminInactive().
CREATE OR REPLACE FUNCTION public.admin_list_admins(p_actor_id uuid, p_token text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE a admin_users; res jsonb;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.full_name), '[]'::jsonb) INTO res
  FROM (
    SELECT id, username, email, is_active, role, full_name,
           company_id, failed_attempts, locked_until
    FROM admin_users
    WHERE company_id = a.company_id AND role <> 'developer'
  ) t;
  RETURN res;
END; $$;

-- 2) DEVELOPER-only: every non-developer admin across ALL companies,
--    with the company name/code nested as `co` (mirrors the old
--    select('..., co:companies(name,code)')). Used by loadDevAccounts() +
--    loadDevInactive(); both filter active/inactive client-side.
CREATE OR REPLACE FUNCTION public.dev_list_admins(p_actor_id uuid, p_token text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE a admin_users; res jsonb;
BEGIN
  a := _wc_admin(p_actor_id, p_token);
  IF a.id IS NULL OR a.role <> 'developer' THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(jsonb_agg(s.row ORDER BY s.full_name), '[]'::jsonb) INTO res
  FROM (
    SELECT au.full_name,
      jsonb_build_object(
        'id', au.id, 'username', au.username, 'email', au.email,
        'is_active', au.is_active, 'role', au.role, 'full_name', au.full_name,
        'company_id', au.company_id, 'failed_attempts', au.failed_attempts,
        'locked_until', au.locked_until,
        'co', CASE WHEN c.id IS NULL THEN NULL
                   ELSE jsonb_build_object('name', c.name, 'code', c.code) END
      ) AS row
    FROM admin_users au
    LEFT JOIN companies c ON c.id = au.company_id
    WHERE au.role <> 'developer'
  ) s;
  RETURN res;
END; $$;

-- Undo, if ever needed:
--   DROP FUNCTION IF EXISTS public.admin_list_admins(uuid, text);
--   DROP FUNCTION IF EXISTS public.dev_list_admins(uuid, text);
