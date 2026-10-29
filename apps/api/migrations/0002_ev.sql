-- EDRI's operational data as the connectors see it (simulated in this repository by sim/).
-- Rows carry their country; a viewer sees the countries their Entra groups grant.
create schema if not exists ev;

create table ev.chargepoints (
  id text primary key,
  site text not null,
  city text not null,
  country char(2) not null,
  lat double precision not null,
  lon double precision not null,
  power_kw int not null,
  vendor text not null,
  model text not null,
  firmware text not null,
  status text not null,
  last_seen timestamptz not null
);
create index chargepoints_country_city on ev.chargepoints (country, lower(city));

create table ev.status_events (
  id bigserial primary key,
  cp_id text not null references ev.chargepoints (id),
  country char(2) not null,
  at timestamptz not null,
  connector int not null,
  status text not null,
  error_code text not null,
  vendor_error_code text
);
create index status_events_cp_at on ev.status_events (cp_id, at desc);

create table ev.tickets (
  id text primary key,
  cp_id text not null references ev.chargepoints (id),
  country char(2) not null,
  title text not null,
  status text not null check (status in ('open', 'closed')),
  opened timestamptz not null,
  closed timestamptz,
  technician text not null,
  resolution_cause text
);
create index tickets_cp on ev.tickets (cp_id);

create table ev.ticket_comments (
  id bigserial primary key,
  ticket_id text not null references ev.tickets (id),
  country char(2) not null,
  author_oid uuid not null,
  author_name text not null,
  via_app text,
  text text not null,
  at timestamptz not null default now()
);

create table ev.monthly_sessions (
  month date not null,
  site text not null,
  country char(2) not null,
  sessions int not null,
  kwh numeric(14, 1) not null,
  revenue_eur numeric(14, 2) not null,
  primary key (month, site)
);

create table ev.partner_contracts (
  partner text not null,
  site text not null,
  country char(2) not null,
  start_date date not null,
  end_date date not null,
  revenue_share_pct numeric(5, 2) not null,
  rent_eur_month numeric(10, 2) not null,
  primary key (partner, site)
);

create table ev.docs (
  id serial primary key,
  source text not null,
  heading text not null,
  text text not null,
  tsv tsvector generated always as (to_tsvector('english', heading || ' ' || text)) stored
);
create index docs_tsv on ev.docs using gin (tsv);

-- Country scoping for the API's connections. foundry.viewer_countries is a comma list or '*'.
do $$
declare t text;
begin
  foreach t in array array['chargepoints', 'status_events', 'tickets', 'ticket_comments', 'monthly_sessions', 'partner_contracts'] loop
    execute format('alter table ev.%I enable row level security', t);
    execute format('alter table ev.%I force row level security', t);
    execute format($p$create policy viewer_countries on ev.%I
      using (current_setting('foundry.viewer_countries', true) = '*'
             or country = any (string_to_array(nullif(current_setting('foundry.viewer_countries', true), ''), ',')))
      with check (current_setting('foundry.viewer_countries', true) = '*'
             or country = any (string_to_array(nullif(current_setting('foundry.viewer_countries', true), ''), ',')))$p$, t);
  end loop;
end $$;
