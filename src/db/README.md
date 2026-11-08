-- Placeholder: drizzle-kit manages migrations in ./drizzle
# Platform administration

The platform owner is a dedicated user in `platform_admins`; ordinary business roles cannot grant this access. Provision the first account from an operator-controlled environment after configuring `DATABASE_URL`:

```powershell
$env:PLATFORM_ADMIN_EMAIL = "owner@example.com"
$env:PLATFORM_ADMIN_NAME = "Platform Owner"
$env:PLATFORM_ADMIN_PASSWORD = "use-a-unique-password-of-10-or-more-characters"
npm run platform:provision-admin
```

Use a new email address that is not already registered as a business user. Set `AUTH_SECRET` to a random secret of at least 32 characters in production before starting the app. Do not expose either secret to the browser.

The initial Free, Plus, and Premium records are inserted with zero prices as editable catalog templates. The application does not connect a payment gateway; payment rows remain pending until a future verified provider integration is added.
