declare function publishArtifact(): void;
declare function appendEventWithArtifacts(): void;
declare function commitAuthorization(): void;
declare function authorizeTarget(): void;
declare function assertGroupAbsent(): void;
declare function commitOutcome(): void;
declare function deliverOutcome(): void;
declare function assertFresh(): void;
declare function reserveLimits(): void;
declare function prepareAttempt(): void;
declare function validateEnvelope(): void;
declare function applyMessage(): void;
declare function preflightProvider(): void;
declare function buildProviderInvocation(): void;
declare function requireCommittedApprovalGateOpened(): void;
declare function authorizeApprovedEffect(): void;

function unsafeControls(): void {
  appendEventWithArtifacts();
  publishArtifact();
  authorizeTarget();
  commitAuthorization();
  deliverOutcome();
  commitOutcome();
  assertGroupAbsent();
  prepareAttempt();
  assertFresh();
  reserveLimits();
  applyMessage();
  validateEnvelope();
  buildProviderInvocation();
  preflightProvider();
  authorizeApprovedEffect();
  requireCommittedApprovalGateOpened();
}
