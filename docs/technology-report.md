# Technology Selection Report

## 1. Why JavaScript

A single language lets browser and server import the same constants and avoids conflicting definitions of status, priority, roles and escalation. JavaScript ES modules support reusable classes and synchronous domain calculations. The API validates client data at runtime, including all domain inputs.

## 2. Why React

The role workspaces share forms, tables, badges and detail components. React manages visited tabs and edited fields while polling or processing an event. The app uses browser history for tab, profile and ticket links. esbuild produces a small static bundle that Express serves on the same origin.

## 3. Why Node.js and Express

Node.js runs the asynchronous MongoDB driver, HTTP API, native crypto, stream responses and SLA monitor in one process. Express gives the app route middleware for origin checks, authorization and validation. Asynchronous password work happens before write transactions to avoid extending incident write contention.

## 4. Why MongoDB

An incident document fits the incident aggregate with an SLA object, notes and feedback. Related records such as users, audit and inbox messages have separate collections and indexes. A replica set supports transactions when an action updates a ticket, workload and event records together. TTL indexes expire sessions and login-attempt counters. [MongoDB Node.js transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)

## 5. Why layered full stack

The React browser handles display and user input. Express authenticates and parses requests. The services call the workflow commands and strategies. Repositories handle MongoDB. This makes the lifecycle and forecast independently testable and keeps application policy out of the browser and HTTP handlers.

## 6. What alternatives were considered

Java/Swing could provide a capable desktop demo but would require provisioning a desktop installation for each user. Java with Spring Boot and PostgreSQL would support a typed API and database-enforced relationships. Angular with a SQL backend could organize a larger client. React, Express and MongoDB fit the existing full-stack project and its document-shaped incident model with fewer separate language toolchains.

## 7. What are the advantages and limitations

Advantages include shared types of values, a self-contained browser build, simple APIs and indexed document storage. Runtime validation is important because JavaScript is dynamically typed. MongoDB leaves cross-document references to application logic. Replica-set configuration adds an operational dependency. Email and SMS are simulated. The SLA estimate depends on local history and its adjustments have no external calibration.

## 8. How the stack supports object-oriented design

`User` subclasses specialize role data and visibility. `UserFactory` constructs and hydrates the correct subclass. `Incident` holds its state object and delegates legal transitions to it. Incident commands share an `execute` contract. Assignment and priority strategies share ranking and evaluation contracts. `EventBus` dispatches domain events to observers. Notification adapters share one delivery contract and extend the observer without changing the incident engine. Mongo repositories encapsulate collections and transaction sessions. [Actual classes](class-diagram.md)

## 9. How the system would scale

Read and report workloads would first be measured against incident cardinality, tenant size, latency and monitor throughput. User-scoped indexes and pagination already limit typical queries. The previous global settings lock has been removed. Separate atomic counters allocate IDs, workflow commands use incident versions, and a technician document is the conditional write boundary for capacity. Counters by prefix, very active service/category records, and the shared round-robin cursor can still contend. At higher scale, cache catalog reads, pre-aggregate workload and reporting metrics, schedule SLA work by deadline in batches, and use change streams or a broker so all API processes can deliver committed events. The current local build has no measured organization-wide capacity.
