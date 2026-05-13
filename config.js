const SUPABASE_URL = 'https://uwxnbaicwfbygvkiyhcf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3eG5iYWljd2ZieWd2a2l5aGNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzEwOTEsImV4cCI6MjA4ODc0NzA5MX0.eEf8iGPW43yPyt2tQU9W2r3rzLwXmGhVMtyNrgMXy5Y';

// Use a different name to avoid conflict with the supabase library global
var db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── EmailJS — password reset OTP ─────────────────────
// Fill these in after setting up your free EmailJS account (see setup instructions)
const EMAILJS_PUBLIC_KEY  = 'YOUR_PUBLIC_KEY';
const EMAILJS_SERVICE_ID  = 'YOUR_SERVICE_ID';
const EMAILJS_TEMPLATE_ID = 'YOUR_TEMPLATE_ID';
const ADMIN_RECOVERY_EMAIL = 'hennie.mohlatswa@outlook.com';
