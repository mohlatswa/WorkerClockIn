const SUPABASE_URL = 'https://uwxnbaicwfbygvkiyhcf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3eG5iYWljd2ZieWd2a2l5aGNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzEwOTEsImV4cCI6MjA4ODc0NzA5MX0.eEf8iGPW43yPyt2tQU9W2r3rzLwXmGhVMtyNrgMXy5Y';

// Use a different name to avoid conflict with the supabase library global
var db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── EmailJS — password reset OTP ─────────────────────
// Fill these in after setting up your free EmailJS account (see setup instructions)
const EMAILJS_PUBLIC_KEY  = 'HnoHlNn9Y3Ha8c-yc';
const EMAILJS_SERVICE_ID  = 'service_b5s8tnq';
const EMAILJS_TEMPLATE_ID = 'template_co5hrl3';
const ADMIN_RECOVERY_EMAIL = 'hennie.mohlatswa@outlook.com';

// ── Sentry error tracking (optional crash alerts) ────
// 1. Create a free project at https://sentry.io  → choose "Browser / JavaScript"
// 2. Copy the DSN it gives you (looks like https://abc123@o0.ingest.sentry.io/123)
// 3. Paste it between the quotes below and redeploy.
// Leave it blank to keep Sentry OFF — no Sentry code loads when empty.
const SENTRY_DSN = '';
