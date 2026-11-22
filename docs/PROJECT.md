# Nexora ServiceDesk project report

## Problem analysis

An IT failure can interrupt a business service before the support team knows its impact. For example, several employees might report the same payment outage while a technician is already at capacity. An unstructured queue makes it difficult to set consistent priorities, find related reports, or tell whether the support team met its response and resolution targets.

Nexora gives employees a place to report and track incidents, technicians a queue for assigned work, and administrators a view of operational pressure and policy settings. The application classifies incoming reports, computes a priority and service-level agreement (SLA), ranks available technicians, and records decisions so the organization can review them later.

## Requirements specification

| Area                     | Required behavior                                                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access                   | Sign in and sign out. Support employee registration and the Employee, Technician, and Administrator roles. Enforce role and ticket visibility at the API boundary.                                                                                                      |
| Reporting an incident    | Capture the affected service, title, description, impact, urgency, and number of affected users. Suggest a category and flag likely duplicates before an employee submits. Return the incident and assignment outcome.                                                  |
| Incident records         | Track the reporter, category, severity inputs, priority, technician, status, SLA, notes, resolution, verification, feedback, and closure. Keep related incident references and timestamps.                                                                              |
| Technician queue         | Show assigned incidents and workload. Let technicians acknowledge, investigate, add notes, ask for information, resolve, and close verified incidents. A technician can decline before acknowledgement. Resolve competing assignments within the technician's capacity. |
| Reporter workflow        | Search and track submitted incidents, reply to requests for information, accept and rate a resolution, reopen work by rejecting a resolution, and cancel an open incident.                                                                                              |
| Administration           | Manage users, technicians, IT services, incident categories, SLA policies, and assignment settings. Assign or unassign open work. Review related incidents, urgent work, SLA findings, reports, the audit log, and the outbox.                                          |
| Notifications            | Generate in-app notices and email and SMS outbox entries for the events each channel supports. Update the recipient's inbox as new events commit and keep read status in MongoDB.                                                                                       |
| Reporting                | Show live incident trends, resolution forecasts and per-service counts on the administrator dashboard. Export a CSV.                                                                                                                                                    |
| Search                   | Narrow a role's permitted queue by incident ID, keyword, date range, status, priority, category, service, and SLA status. Administrators can also filter by technician.                                                                                                 |
| Automated decisions      | Suggest categories and previous resolutions, calculate priorities, recommend technicians, detect duplicates and correlated outages, warn about SLA risk, and escalate overdue unacknowledged critical incidents.                                                        |
| Persistence and evidence | Store incident data, history, and notifications in MongoDB. Record changes with the actor, action, incident, time, and relevant state transition.                                                                                                                       |

### Quality requirements

- An employee sees their own incident records. A technician works the assigned queue, and an administrator monitors the organization. Shared browser controls call the same authorization rules as direct API clients.
- Record changes, audit events, and generated notices must stay consistent when an operation fails or another request arrives at the same time. A double submission with the same request identifier should produce one incident.
- The interface should be usable on desktop and mobile browsers. Lists support pagination and filters so that users can find work without loading an entire collection into the browser.
- Record timestamps are stored as UTC instants. Calendar-date searches use the configured reporting time zone.
- Domain errors return actionable messages for invalid input, denied actions, illegal transitions, missing service or SLA records, and unavailable capacity.

### Business rules

The default priority method converts Low, Medium, High, and Critical to 1, 2, 3, and 4. It multiplies impact, urgency, and service criticality, then applies an affected-user factor. The factor is 1 below 10 users, 1.25 from 10, 1.5 from 50, and 2 from 200. A result of at least 36 is P1, at least 18 is P2, at least 6 is P3, and a lower score is P4. The optional rule-based strategy instead evaluates ordered business rules and uses the first matching rule. This lets the team express exceptions such as a high-impact security incident explicitly.

An assignment must satisfy technician availability, account status, and capacity. Administrators can select skill-based scoring, least load, experience-based scoring, or round robin. Skill-based scoring combines category fit, free capacity, experience, and completed work on the affected service. Round robin orders eligible technicians by ID and rotates after the last assignment. A report without an eligible technician goes to the manual assignment queue.

The SLA policy comes from the affected service or the configured default. Response and resolution are separately timed. When support requests more information, the resolution clock pauses. When the incident resumes, the resolution deadline extends by the elapsed pause. The response clock retains its recorded acknowledgement. An SLA warning signals an approaching deadline. A breach records a missed deadline. An urgent incident still awaiting acknowledgement can be escalated to the team lead, system administrator, and IT manager. The [predictive model](predictive-sla.md) uses closed cases and the current workflow to estimate an open resolution target's likelihood of breach.

Duplicate detection compares sets of normalized words and adds weight for a matching service and category. The text score is 0.7 times the Jaccard similarity of normalized title and description terms, with 0.2 for a matching service and 0.1 for a matching category. A score of at least 0.45 can link reports and a score of at least 0.85 prompts for confirmation. Three or more open incidents on one service within an hour can raise a suspected outage. Resolution suggestions are derived from earlier permitted incident records.

An employee cancellation is terminal and releases the assigned technician's slot. A declined assignment or an administrator's unassignment returns the incident to the classified queue for review.

### Assumptions

Nexora serves a single organization's service catalogue. The local demonstration uses seeded sample records, representative service policies, and simulation channels. Administrators maintain roles and escalation contacts. [Security](security.md)

## Demonstration script

The [demo script](demo-script.md) has three workflows and a 17-minute run of show.

## Reference material

- [Architecture](architecture.md), [class diagrams](class-diagram.md), and [use cases](use-case.md)
- [MongoDB schema, ER diagram, and sample data](er-diagram.md)
- [Technology Selection Report](technology-report.md)
- [Security considerations](security.md)
- [Test cases and verification](test-cases.md)
