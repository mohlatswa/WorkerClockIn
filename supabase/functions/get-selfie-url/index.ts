// WorkClock-In — get-selfie-url
// Returns a short-lived signed URL for a clock-in selfie, but only to an admin
// who owns the company that the attendance row belongs to. Runs with the service
// role (bypasses Storage RLS), so the bucket can stay fully private.
//
// Deploy:
//   supabase functions deploy get-selfie-url
// JWT verification stays ON: the frontend invokes via supabase-js (sends the
// project anon key), and the function ALSO does its own admin-session check in
// the body. Requires the standard SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// secrets (present by default in the Supabase Edge runtime).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { actor_id, token, attendance_id } = await req.json();
    if (!actor_id || !token || !attendance_id) return json({ error: "bad_request" }, 400);

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1) Authenticate the admin by their session token.
    const { data: admin } = await db
      .from("admin_users")
      .select("id, company_id, session_token, role")
      .eq("id", actor_id)
      .maybeSingle();
    if (!admin || !admin.session_token || admin.session_token !== token || !admin.company_id) {
      return json({ error: "unauthorized" }, 401);
    }

    // 2) Fetch the attendance row and confirm it belongs to the admin's company.
    const { data: att } = await db
      .from("attendance")
      .select("selfie_path, company_id")
      .eq("id", attendance_id)
      .maybeSingle();
    if (!att || !att.selfie_path) return json({ error: "no_selfie" }, 404);
    if (att.company_id !== admin.company_id) return json({ error: "forbidden" }, 403);

    // 3) Hand back a short-lived signed URL (120s).
    const { data: signed, error } = await db
      .storage.from("clock-selfies")
      .createSignedUrl(att.selfie_path, 120);
    if (error || !signed) return json({ error: "sign_failed" }, 500);

    return json({ url: signed.signedUrl });
  } catch (_e) {
    return json({ error: "server_error" }, 500);
  }
});
