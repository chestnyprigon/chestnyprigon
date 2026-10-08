-- Manual review is not an operational destination. Preserve the existing
-- reason codes while converting legacy rows to an explicit non-publishable
-- isolated outcome.
alter table public.listing_screening
  drop constraint if exists listing_screening_decision_check;


update public.listing_screening
set decision = 'isolated',
    is_problematic = true
where decision = 'manual_review';

alter table public.listing_screening
  add constraint listing_screening_decision_check
  check (decision in ('pending', 'approved', 'rejected', 'isolated'));
