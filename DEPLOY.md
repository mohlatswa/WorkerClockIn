# WorkClock — Deploy & Security Notes

## What changed in this update

**Security (the important part)**

- **Credential exfiltration closed.** The public anon key in `config.js` could
  previously read *every* admin password hash and *every* worker PIN hash and
  reverse them offline (PINs are 4–6 digits; hashes were unsalted SHA-256).
  PIN verification and password resets now happen in server-side
  `SECURITY DEFINER` RPCs, and the frontend no longer fetches any credential
  column. `security_lockdown.sql` revokes read access to those columns.
- **Stored XSS fixed.** All user-controlled text (worker/admin/company names,
  emails, employee IDs, job titles) is now HTML-escaped before being inserted
  into the admin and developer dashboards via `innerHTML`.
- **Password reset hardened.** OTPs are generated and verified entirely
  server-side; the reset token hash is never sent to the browser.

**Correctness / housekeeping**

- Service-worker cache bumped to `wc-v6` so returning users actually receive
  the new code.
- `schema.sql` rewritten to match the real production schema (the old one
  claimed RLS was disabled and shipped a plaintext `admin123` default — both
  untrue and misleading).

## Deploy order — IMPORTANT

The live site runs the *currently deployed* `app.js` until you push. The
database lockdown will break the old code, so the order matters:

1. **Deploy the code first.** Commit and push `app.js`, `index.html`, `sw.js`,
   `schema.sql` to GitHub Pages.
2. **Confirm the live site works** — load `https://mohlatswa.github.io/WorkerClockIn/`,
   do a hard refresh (the new service worker will update), and test:
   - a worker signs in with their PIN and clocks in/out,
   - an admin logs in and opens the Workers / Admins tabs,
   - the "Forgot password" flow emails a code and resets.
3. **Then run `security_lockdown.sql`** (Phase 1) in the Supabase SQL Editor.
4. Re-test the same three flows. Verify the revoke worked:
   ```sql
   SELECT has_column_privilege('anon','public.admin_users','password_hash','SELECT'),
          has_column_privilege('anon','public.workers','pin','SELECT');
   -- both should be FALSE
   ```

## Phase 2 — admin/company write-hardening ✅ DONE

Admins now get a server-issued **session token** (`admin_login_v2`), and every
`admin_users` / `companies` write goes through a `SECURITY DEFINER` RPC that
verifies the token + the actor's role/company. Direct anon INSERT/UPDATE/DELETE
on those two tables is **revoked** (`workclock_revoke_admin_company_writes`).
The account-takeover vector is closed (a direct `update admin_users` from the
anon key now fails with 42501).

## Still open — Phase 2b (next)

`workers`, `workplaces` and `attendance` are still writable by the anon key
within active companies (PIN resets, device rebind, forged attendance). Closing
this means routing the worker clock-in path + admin worker/workplace management
through session-verified RPCs, then revoking direct writes on those tables.

The anon key is *meant* to be public — the fix is correct RLS + RPCs, never
hiding the key.
