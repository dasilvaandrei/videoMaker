-- Confirmed against a real discover-campaigns run: Whop campaigns can
-- require an application/approval before you're actually let in, not just
-- instant join. Surfacing this matters for the manual join workflow (a
-- human should know upfront whether joining means "post now" or "apply and
-- wait"), so it gets a real column rather than staying buried in `raw`.

alter table campaigns
  add column requires_application boolean not null default false;
