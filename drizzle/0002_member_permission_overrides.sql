CREATE TABLE membership_permission_overrides (
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  allowed boolean NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_permission_overrides_pk PRIMARY KEY (membership_id, permission_key)
);--> statement-breakpoint
CREATE INDEX membership_permission_overrides_membership_idx ON membership_permission_overrides(membership_id);
