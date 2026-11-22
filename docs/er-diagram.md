# MongoDB schema

The diagram describes logical references. Incident SLA, notes and feedback are embedded. Application code and transactions maintain references between collections.

```mermaid
erDiagram
  USER ||--o{ INCIDENT : reports
  USER o|--o{ INCIDENT : assigned_to
  SERVICE ||--o{ INCIDENT : affected_service
  CATEGORY ||--o{ INCIDENT : classified_as
  SLA_POLICY o|--o{ SERVICE : overrides
  CATEGORY o|--o{ SERVICE : defaults_to
  SLA_POLICY ||--o| SETTINGS : defaults_to
  INCIDENT o|--o{ AUDIT : chronicles
  USER o|--o{ AUDIT : account_action
  USER ||--o{ SESSION : authenticates
  USER ||--o{ NOTIFICATION : receives
  INCIDENT ||--o{ NOTIFICATION : concerns
  INCIDENT o|--o{ EMAIL_OUTBOX : concerns
  INCIDENT ||--o{ SMS_OUTBOX : concerns
  USER ||--o{ SMS_OUTBOX : recipient
  INCIDENT {
    string _id PK
    string reporter FK
    string assignedTo FK
    string service FK
    string category FK
    string title
    string status
    string priority
    int version
    date createdAt
    object sla
    array notes
    array relatedIds
  }
  USER {
    string _id PK
    string email UK
    string role
    bool active
    string passwordHash
    int authVersion
    int activeLoad
  }
  SERVICE {
    string _id PK
    string name
    string policy FK
    string defaultCategory FK
    string criticality
  }
  CATEGORY {
    string _id PK
    string name
    array keywords
  }
  SLA_POLICY {
    string _id PK
    string name
    object targets
  }
  SETTINGS {
    string _id PK
    string defaultPolicyId FK
    string assignmentStrategyKey
    string priorityStrategyKey
    int riskThresholdPercent
    int schemaVersion
  }
  AUDIT {
    string _id PK
    string incidentId FK
    string accountId FK
    string action
    date timestamp
  }
  NOTIFICATION {
    string _id PK
    string incidentId FK
    string recipientId FK
    bool read
    date createdAt
  }
  EMAIL_OUTBOX {
    string _id PK
    string incidentId FK
    string to
    string state
    date createdAt
  }
  SMS_OUTBOX {
    string _id PK
    string incidentId FK
    string recipientId FK
    string state
    date createdAt
  }
  SESSION {
    string _id PK
    string userId FK
    int authVersion
    date expiresAt
  }
  ATTEMPT {
    string _id PK
    int count
    date expiresAt
    date lockedUntil
  }
  COUNTER {
    string _id PK
    int value
  }
```

| Collection                           | Details                                                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                              | Employees store department and location. Technician fields include skills, experience, team lead, availability, maximum capacity and current open load. Administrators have a title.                                                                          |
| `incidents`                          | Stores metadata, lifecycle version, references and a reporter-scoped request ID. The embedded SLA records targets, timestamps, findings, pause duration and `riskNotified`. Related IDs are bidirectional. `sampleTag` identifies optional synthetic history. |
| `services`, `categories`, `policies` | Service catalogue, classification keywords and per-priority SLA targets.                                                                                                                                                                                      |
| `audit`, `notifications`             | Append-only operation history and per-user in-app messages with read state. Account audit entries have `accountId` and a null incident ID.                                                                                                                    |
| `emailOutbox`, `smsOutbox`           | Simulated deliveries. Older email rows may only have the destination address.                                                                                                                                                                                 |
| `settings`, `counters`               | The `global` document stores configuration. Per-prefix counters allocate IDs independently.                                                                                                                                                                   |
| `sessions`, `attempts`               | Expiring sessions and login quotas. The stored session identifier is a digest.                                                                                                                                                                                |

Unique indexes cover user email, the incident reporter/request ID pair and synthetic history tags where present. Additional indexes support the reporter, assignee, service and priority queries, closed-history selection, audit history, recipients and outbox ordering. Sessions and attempt counters have TTL indexes. See the index definitions in [database.js](../server/database.js).

Selected fields from the bundled seed:

```json
{
  "_id": "SVC1",
  "name": "Payment Gateway",
  "criticality": "CRITICAL",
  "policy": "SLA1",
  "defaultCategory": "Application"
}
```

```json
{ "_id": "SLA1", "name": "Gold", "targets": { "P1": { "responseMinutes": 5, "resolutionMinutes": 30 } } }
```

The demo imports 11 users, 11 incidents, 8 services, 9 categories, 2 policies, 87 audit rows, 108 in-app notifications and 96 simulated emails. The upgrade from schema 1 preserves records, reconstructs active technician loads, and initializes pauses on existing pending-information cases. [Original demo snapshot](../server/seed/snapshot.json)
