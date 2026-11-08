CREATE TYPE platform_subscription_status AS ENUM ('trial', 'active', 'pending_payment', 'expired', 'suspended', 'cancelled');--> statement-breakpoint
ALTER TABLE businesses ADD COLUMN platform_status text NOT NULL DEFAULT 'active' CHECK (platform_status IN ('active', 'suspended'));--> statement-breakpoint
ALTER TABLE businesses ADD COLUMN max_users_override integer CHECK (max_users_override IS NULL OR max_users_override >= 0);--> statement-breakpoint
ALTER TABLE businesses ADD COLUMN max_products_override integer CHECK (max_products_override IS NULL OR max_products_override >= 0);--> statement-breakpoint

CREATE TABLE platform_admins (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE TABLE subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  monthly_price_minor bigint NOT NULL DEFAULT 0 CHECK (monthly_price_minor >= 0),
  yearly_price_minor bigint NOT NULL DEFAULT 0 CHECK (yearly_price_minor >= 0),
  currency text NOT NULL DEFAULT 'YER',
  trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  max_users integer NOT NULL DEFAULT 1 CHECK (max_users >= 0),
  max_products integer NOT NULL DEFAULT 100 CHECK (max_products >= 0),
  storage_limit_mb integer NOT NULL DEFAULT 500 CHECK (storage_limit_mb >= 0),
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE TABLE business_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES subscription_plans(id) ON DELETE SET NULL,
  status platform_subscription_status NOT NULL DEFAULT 'trial',
  billing_period text NOT NULL DEFAULT 'monthly' CHECK (billing_period IN ('monthly', 'yearly')),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX business_subscriptions_business_idx ON business_subscriptions(business_id);--> statement-breakpoint
CREATE INDEX business_subscriptions_expiry_idx ON business_subscriptions(expires_at);--> statement-breakpoint

CREATE TABLE business_feature_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, feature_key)
);--> statement-breakpoint

CREATE TABLE subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES business_subscriptions(id) ON DELETE SET NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL DEFAULT 'YER',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'refunded')),
  provider text NOT NULL DEFAULT 'manual_pending',
  provider_reference text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX subscription_payments_business_idx ON subscription_payments(business_id, created_at);--> statement-breakpoint

CREATE TABLE subscription_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX subscription_history_business_idx ON subscription_history(business_id, created_at);--> statement-breakpoint

CREATE TABLE platform_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX platform_audit_logs_created_idx ON platform_audit_logs(created_at);--> statement-breakpoint
