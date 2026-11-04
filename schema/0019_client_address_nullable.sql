-- Milestone 5 design doc Decision 2: clients.physical_address was `not null`
-- since 0001_initial_schema.sql, which made spec 7.3's missing-address-blocking
-- path permanently unreachable on the client side. profiles.physical_address
-- stays `not null` -- it's captured once at signup with no edit path that could
-- ever unset it (see the design doc for why building that edit screen is out of
-- scope for this milestone).
alter table clients
  alter column physical_address drop not null;
