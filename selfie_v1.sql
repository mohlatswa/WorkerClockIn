-- ============================================================
-- WorkClock-In — Stage 4: clock-in selfie evidence
-- Captured from the face-verify camera at clock-in, stored in a PRIVATE
-- Storage bucket. The path is recorded on the attendance row; the image
-- itself is never anon-readable — admins view it only through the
-- service-role Edge Function `get-selfie-url` (short-lived signed URL).
-- Run this in the Supabase SQL editor.
-- ============================================================

-- 1) Where the selfie lives (path only; bucket is private)
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS selfie_path text;

-- 2) Worker attaches their own selfie path to their own attendance row.
--    Set-once (selfie_path IS NULL) so it can't be overwritten/tampered.
CREATE OR REPLACE FUNCTION worker_set_selfie(
  p_worker_id uuid, p_token text, p_attendance_id uuid, p_path text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE w workers%ROWTYPE; n int;
BEGIN
  SELECT * INTO w FROM workers WHERE id = p_worker_id AND session_token = p_token AND is_active = TRUE;
  IF NOT FOUND THEN RETURN 'bad_session'; END IF;
  IF p_path IS NULL OR p_path = '' THEN RETURN 'bad_path'; END IF;
  -- only your own row, only if it has no selfie yet
  UPDATE attendance SET selfie_path = p_path
   WHERE id = p_attendance_id AND worker_id = w.id AND selfie_path IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN CASE WHEN n = 0 THEN 'noop' ELSE 'ok' END;
END; $$;

-- 3) Private bucket for the images, capped to small JPEGs to stop abuse
--    (the client uploads a ~480px JPEG at ~0.7 quality, well under 2 MB).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('clock-selfies', 'clock-selfies', false, 2097152, ARRAY['image/jpeg'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 4) Storage policies: anon may UPLOAD (write-only); NO anon read/list.
--    Reads happen only via the service-role Edge Function (bypasses RLS).
--    The path is locked to the app's <uuid>/<uuid>/<uuid>.jpg shape so anon
--    can't dump arbitrary objects into the bucket.
DROP POLICY IF EXISTS clock_selfies_insert ON storage.objects;
CREATE POLICY clock_selfies_insert ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    bucket_id = 'clock-selfies'
    AND name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.jpg$'
  );

-- (Intentionally no SELECT/UPDATE/DELETE policy for anon on this bucket.)

-- Undo, if ever needed:
--   DROP POLICY IF EXISTS clock_selfies_insert ON storage.objects;
--   DELETE FROM storage.buckets WHERE id = 'clock-selfies';
--   ALTER TABLE attendance DROP COLUMN IF EXISTS selfie_path;
--   DROP FUNCTION IF EXISTS worker_set_selfie(uuid,text,uuid,text);
