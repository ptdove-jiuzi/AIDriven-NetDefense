# Security Policy

## Scope and support

AegisHarness is in WP0 implementation. No release is currently supported and
no WP0 acceptance or product security claim is implied by this repository
baseline.

## Reporting a vulnerability

Report suspected vulnerabilities privately through the repository hosting
service's private security-advisory mechanism. Do not open a public issue for
an unremediated vulnerability. If private reporting is unavailable, contact
the repository owner, PT-dove, through the hosting service.

Include the affected commit or package versions, environment, impact, and a
minimal reproduction using only temporary directories and harmless synthetic
data. Never include credentials, real user security logs, personal data, or
unredacted evidence. Do not test against systems you do not own or have
explicit permission to assess.

## Test and handling requirements

- Tests must not read, clear, or modify real user data or security logs.
- Snapshot guards must use an explicitly configured mock real directory inside
  the test temporary directory and fail on any before/after difference.
- Do not enable automatic updates or automatically open a UI.
- Keep dependency versions, resolved URLs, integrity hashes, licenses, and the
  generated SBOM reproducible and reviewable.

Project authors and security contacts must be identified as PT-dove; upstream
and third-party copyright notices remain with their respective owners.
