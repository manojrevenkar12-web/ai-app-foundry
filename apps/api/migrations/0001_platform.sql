-- The platform's own records. foundry (the owner) runs migrations; the API connects as
-- foundry_app, which is not the owner, so row-level security applies to every query it makes.
create schema if not exists foundry;

create table foundry.people (
  tid uuid not null,
  oid uuid not null,
  name text not null,
  last_seen timestamptz not null default now(),
  primary key (tid, oid)
);

create table foundry.apps (
  id text primary key,
  tid uuid not null,
  owner_oid uuid not null,
  owner_name text not null,
  name text not null,
  description text not null,
  status text not null default 'draft' check (status in ('draft', 'live', 'disabled')),
  live_version int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table foundry.app_versions (
  app_id text not null references foundry.apps (id),
  number int not null,
  bundle jsonb not null,
  bundle_hash char(64) not null,
  gate jsonb not null,
  tier smallint not null check (tier between 0 and 2),
  status text not null check (status in ('blocked', 'in_review', 'approved', 'live', 'superseded', 'rejected', 'withdrawn')),
  created_by uuid not null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  primary key (app_id, number)
);

-- An approval names the exact bundle it approved; a different bundle needs a new approval.
create table foundry.approvals (
  app_id text not null,
  number int not null,
  reviewer_oid uuid not null,
  reviewer_name text not null,
  bundle_hash char(64) not null,
  decision text not null check (decision in ('approve', 'reject')),
  comment text not null default '',
  at timestamptz not null default now(),
  primary key (app_id, number, reviewer_oid),
  foreign key (app_id, number) references foundry.app_versions (app_id, number)
);

-- Data apps keep. Isolation is the database's job: a query sees only the app and viewer
-- set for its transaction, and without them it sees nothing.
create table foundry.app_records (
  app_id text not null,
  collection text not null,
  owner_oid uuid, -- null: shared between the app's viewers
  key text not null,
  value jsonb not null,
  classification text not null check (classification in ('public', 'internal', 'confidential')),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create unique index app_records_key on foundry.app_records (app_id, collection, coalesce(owner_oid, '00000000-0000-0000-0000-000000000000'::uuid), key);
create index app_records_expiry on foundry.app_records (expires_at);
alter table foundry.app_records enable row level security;
alter table foundry.app_records force row level security;
create policy app_records_isolation on foundry.app_records
  using (
    app_id = current_setting('foundry.app_id', true)
    and (owner_oid is null or owner_oid = nullif(current_setting('foundry.viewer_oid', true), '')::uuid)
  )
  with check (
    app_id = current_setting('foundry.app_id', true)
    and (owner_oid is null or owner_oid = nullif(current_setting('foundry.viewer_oid', true), '')::uuid)
  );

-- Retention: expired records may be deleted by the purge job, and only expired ones.
create policy app_records_purge on foundry.app_records for delete
  using (current_setting('foundry.maintenance', true) = 'purge' and expires_at <= now());

create table foundry.invocations (
  id bigserial primary key,
  app_id text not null,
  number int not null,
  tid uuid not null,
  viewer_oid uuid not null,
  handler text not null,
  ok boolean not null,
  error_code text,
  wall_ms int not null,
  cpu_ms int not null,
  host_calls int not null,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_micro_eur bigint not null default 0,
  cache_hits int not null default 0,
  at timestamptz not null default now()
);
create index invocations_app_at on foundry.invocations (app_id, at);

create table foundry.api_tokens (
  id text primary key,
  tid uuid not null,
  oid uuid not null,
  name text not null,
  token_hash char(64) not null unique,
  scopes text[] not null,
  -- the owner's permissions when the token was made
  principal jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz
);

-- A write an app asked for, waiting for the viewer to confirm it. One use, short-lived.
create table foundry.confirmations (
  id text primary key,
  app_id text not null,
  number int not null,
  tid uuid not null,
  viewer_oid uuid not null,
  connector text not null,
  args jsonb not null,
  summary text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  outcome jsonb
);

-- Messages sent to other systems (Teams); simulated here, kept for the audit.
create table foundry.outbound (
  id bigserial primary key,
  kind text not null,
  target text not null,
  body text not null,
  author_oid uuid not null,
  app_id text not null,
  at timestamptz not null default now()
);

-- Append-only, hash-chained.
create table foundry.audit (
  seq bigserial primary key,
  at timestamptz not null default now(),
  tid uuid,
  actor text not null,
  action text not null,
  target text not null,
  detail jsonb not null default '{}',
  prev_hash char(64) not null,
  hash char(64) not null
);
create function foundry.audit_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'the audit log is append-only';
end $$;
create trigger audit_no_update before update on foundry.audit for each row execute function foundry.audit_is_append_only();
create trigger audit_no_delete before delete on foundry.audit for each row execute function foundry.audit_is_append_only();
create trigger audit_no_truncate before truncate on foundry.audit for each statement execute function foundry.audit_is_append_only();
