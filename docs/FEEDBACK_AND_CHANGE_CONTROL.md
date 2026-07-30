# Learner feedback and live-course change control

## Rule during a live course

Teach from one tagged baseline. Do not quietly change shared workflows,
instructions, images, or setup scripts while teams are using them.

When something is confusing:

1. help the learner recover using the released instructions;
2. record the observation without names or secrets;
3. create a GitHub issue using the learner-feedback template;
4. reproduce and fix it on a new branch after the session;
5. add a test when the behavior is deterministic;
6. release the improvement through a reviewed pull request and a new version.

Emergency safety fixes may interrupt the baseline. Stop the affected exercise,
explain the issue, revoke exposed credentials when relevant, and record exactly
which teams received the replacement.

## What useful feedback contains

- Release version and commit.
- Anonymous team ID.
- Operating system and processor architecture.
- Exercise or instruction heading.
- What the learner expected.
- What actually happened.
- Whether an instructor intervened.
- The smallest recovery that worked.
- A redacted error message when safe.

Never collect names, email addresses, API keys, passwords, `.env`, credential
exports, full backups, or screenshots containing secrets.

## Priority

| Priority | Meaning |
| --- | --- |
| P0 | Secret/data risk or prevents most teams from continuing |
| P1 | Blocks a team or requires instructor intervention |
| P2 | Repeated confusion or avoidable delay |
| P3 | Cosmetic improvement |

P0 issues pause the affected activity. P1 issues need a documented workaround
before the next delivery.

## Collect examples

Learner projects remain in their own repositories. Share an example only when
the team explicitly agrees and has removed client data, personal information,
credentials, local backups, and confidential task content.

Record a safe example with:

- a short description of the agent’s purpose;
- the release version it started from;
- interface and skill changes;
- one redacted read demonstration;
- one redacted confirmed-write demonstration;
- a link only when repository visibility permits it.

## Close the loop

At the end of each course:

1. group duplicate feedback by root cause;
2. preserve the original observations on the issue;
3. assign an owner and priority;
4. link the fixing pull request;
5. state how it was verified;
6. add the learner-visible result to `CHANGELOG.md`;
7. decide whether the next course uses a patch, minor, or unchanged release.
