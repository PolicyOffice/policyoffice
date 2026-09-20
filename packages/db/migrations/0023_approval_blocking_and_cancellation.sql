-- POL-042: explicit pre-release cancellation evidence.

alter table document_version
  add column cancelled_at timestamptz,
  add column cancellation_reason text,
  add constraint document_version_cancellation_reason_required check (
    lifecycle_state <> 'CANCELLED'
    or nullif(btrim(cancellation_reason), '') is not null
  );

comment on column document_version.cancelled_at is
  'INV-VER-003: records when an authorised pre-release cancellation made the version terminal';
comment on column document_version.cancellation_reason is
  'INV-VER-003: records why an authorised pre-release cancellation made the version terminal';
comment on constraint document_version_cancellation_reason_required on document_version is
  'INV-VER-003: a terminal cancellation is explicit and always retains a non-empty reason';
