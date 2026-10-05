# VHC Safe Supabase Test Environment

Use a dedicated Supabase project containing synthetic data only. Never apply
this setup to `yrgtnhvnwkqudxdcrkhm.supabase.co`.

1. Create a new non-production Supabase project.
2. Run `migrations/20260926000100_vhc_safe_test_schema.sql` in that project.
3. Create a synthetic validation user under Authentication > Users. Do not
   copy any production account or patient identity.
4. Set the process environment variables shown in
   `../config/vhc-test.env.example` before
   launching Electron. Environment files are examples only; the application
   reads process environment variables and does not load dotenv files.
5. Confirm the application displays `Environment: TEST` before validation.

Required application values:

- `VHC_SUPABASE_ENVIRONMENT=TEST`
- `VHC_TEST_SUPABASE_URL`
- `VHC_TEST_SUPABASE_ANON_KEY`

Required only for the synthetic-data reset utility:

- `VHC_TEST_SUPABASE_SERVICE_ROLE_KEY`

No redirect URL is required for the current password-based Electron login.
The migration enables row-level security and grants table access only to an
authenticated synthetic test user. The reset utility uses the TEST service
role and deletes only bill IDs beginning with `TEST-VHC-`; it refuses the
production hostname before constructing its client.
