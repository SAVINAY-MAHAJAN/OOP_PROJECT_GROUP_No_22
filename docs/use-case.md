# Use cases

```mermaid
flowchart LR
  Employee(["Employee"])
  Technician(["Technician"])
  Admin(["Administrator"])
  Monitor(["Scheduled SLA monitor"])
  subgraph Nexora["Nexora ServiceDesk"]
    SignIn(["Sign in, view profile and change password"])
    Inbox(["Receive live notifications and manage inbox"])
    Search(["Search and filter authorized incidents"])
    Report(["Report incident and confirm duplicates"])
    Reply(["Reply and verify, reject or cancel"])
    Work(["Acknowledge, investigate, request info and resolve"])
    Capacity(["View workload, decline or update availability"])
    Assign(["Assign, unassign or override priority"])
    Configure(["Manage users, catalogue, SLA policies and settings"])
    Observe(["Review live dashboard, forecasts, audit, outbox and CSV"])
    SLA(["Evaluate SLA warnings, breaches, forecasts and escalation"])
  end
  Employee --- SignIn
  Technician --- SignIn
  Admin --- SignIn
  Employee --- Inbox
  Technician --- Inbox
  Admin --- Inbox
  Employee --- Search
  Technician --- Search
  Admin --- Search
  Employee --- Report
  Employee --- Reply
  Technician --- Work
  Technician --- Capacity
  Admin --- Assign
  Admin --- Configure
  Admin --- Observe
  Monitor --- SLA
  Admin --- SLA
```

Employees work on reports they submitted. The technician queue shows assignments. Technicians can read assigned incidents and incidents they reported. Administrators can inspect all incidents. The server validates the role and ownership again for every operation.

```mermaid
stateDiagram-v2
  [*] --> NEW
  NEW --> CLASSIFIED
  CLASSIFIED --> ASSIGNED
  ASSIGNED --> ACKNOWLEDGED
  ACKNOWLEDGED --> IN_PROGRESS
  IN_PROGRESS --> PENDING_INFO
  PENDING_INFO --> IN_PROGRESS
  IN_PROGRESS --> RESOLVED
  RESOLVED --> IN_PROGRESS
  RESOLVED --> VERIFIED
  VERIFIED --> CLOSED
  ASSIGNED --> CLASSIFIED
  ACKNOWLEDGED --> CLASSIFIED
  IN_PROGRESS --> CLASSIFIED
  PENDING_INFO --> CLASSIFIED
  NEW --> CANCELLED
  CLASSIFIED --> CANCELLED
  ASSIGNED --> CANCELLED
  ACKNOWLEDGED --> CANCELLED
  IN_PROGRESS --> CANCELLED
  PENDING_INFO --> CANCELLED
  CLOSED --> [*]
  CANCELLED --> [*]
```

In pending information, the resolution clock is paused. Replying, resuming investigation or clearing the assignment resumes it. A completed response clock retains its deadline and acknowledgement.
