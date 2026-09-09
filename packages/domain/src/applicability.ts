/** Closed applicability vocabulary shared by domain entry points and persistence. */
export const APPLICABILITY_EFFECTS = Object.freeze(["INCLUDE", "EXCLUDE"] as const);
export const INHERITANCE_MODES = Object.freeze(["MANDATORY", "DEFAULT", "LOCAL_ONLY"] as const);
export const ALIGNMENT_SUBJECT_TYPES = Object.freeze([
  "DOCUMENT_VARIANT",
  "DOCUMENT_TYPE",
] as const);
export const ALIGNMENT_OBLIGATION_STATUSES = Object.freeze(["OPEN", "RESOLVED"] as const);

export type ApplicabilityEffect = (typeof APPLICABILITY_EFFECTS)[number];
export type InheritanceMode = (typeof INHERITANCE_MODES)[number];
export type AlignmentSubjectType = (typeof ALIGNMENT_SUBJECT_TYPES)[number];
export type AlignmentObligationStatus = (typeof ALIGNMENT_OBLIGATION_STATUSES)[number];

export const APPLICABILITY_REQUIRED_CAPABILITIES = Object.freeze({
  changeRules: "document.manage_applicability",
} as const);

export interface AlignmentObligationDeadline {
  status: AlignmentObligationStatus;
  dueAt: Date | null;
}

export interface AlignmentObligationDeadlineVisibility {
  overdue: boolean;
  governanceExceptionVisible: boolean;
}

export interface ApplicabilityRule {
  tenantId: string;
  id: string;
  documentVariantId: string;
  authorisedByVersionId: string | null;
  effect: ApplicabilityEffect;
  legalEntityIds: readonly string[];
  orgUnitIds: readonly string[];
  jurisdictionIds: readonly string[];
  groupIds: readonly string[];
  userIds: readonly string[];
  inheritanceMode: InheritanceMode;
  validFrom: Date;
  validUntil: Date | null;
}

export interface AlignmentObligation {
  tenantId: string;
  id: string;
  subjectType: AlignmentSubjectType;
  subjectId: string;
  sourceVersionId: string;
  raisedAt: Date;
  dueAt: Date | null;
  reason: string;
  status: AlignmentObligationStatus;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  resolvingReviewCaseId: string | null;
}

function requireDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
}

/**
 * Derive deadline visibility without performing or implying a lifecycle transition.
 *
 * Passing a deadline makes an open obligation visible as an exception. It does not
 * resolve the obligation and cannot affect either the upstream or downstream version.
 */
export function evaluateAlignmentObligationDeadline(
  obligation: Readonly<AlignmentObligationDeadline>,
  asOf: Date,
): AlignmentObligationDeadlineVisibility {
  requireDate(asOf, "asOf");
  if (obligation.dueAt !== null) requireDate(obligation.dueAt, "obligation.dueAt");

  const overdue =
    obligation.status === "OPEN" &&
    obligation.dueAt !== null &&
    obligation.dueAt.valueOf() <= asOf.valueOf();

  return Object.freeze({
    overdue,
    governanceExceptionVisible: overdue,
  });
}
