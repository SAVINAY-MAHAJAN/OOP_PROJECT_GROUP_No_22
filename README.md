# Nexora ServiceDesk

[![CI workflow configured](https://img.shields.io/badge/CI-workflow_configured-2563eb)](.github/workflows/ci.yml)

Nexora is an Option C incident management system with a React frontend, a Node.js/Express REST API and MongoDB storage. Employees report and track incidents, technicians investigate and resolve them, and administrators manage the service catalogue, queues, SLAs and reports.

## Run locally

Install Node.js 22.19 or newer. From the project directory run:

```sh
npm ci
npm run build
npm start
```

Open [Nexora sign-in](http://127.0.0.1:18120/login). On Windows, `run.bat` installs dependencies and starts the app. The first launch downloads the official MongoDB Community binary if it is absent from the local cache. Windows on ARM uses the Windows x64 build. The bundled MongoDB process runs as a single-member replica set on port 27271 and keeps its records in `.data/mongo`. Press Ctrl+C to stop both processes.

The default loopback setup includes the sample cards. Select **Fill form**, then **Sign in**. With the demo running, use `npm run demo:history` in a second terminal to add synthetic forecast history. The [demo script](docs/demo-script.md) walks through the three roles and the two live innovations.

## Run with Docker

```sh
docker compose up --build
```

Use the same loopback login URL. Compose waits for its single-member MongoDB replica set and keeps its database in the `nexora_mongo` volume. Run `docker compose exec app npm run demo:history` to add forecast history inside that database. [Docker Compose readiness](https://docs.docker.com/compose/how-tos/startup-order/)

## Configuration

| Variable                                                  | Default for local demo                            | Purpose                                                                   |
| --------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `HOST`, `PORT`                                            | `127.0.0.1`, `18120`                              | HTTP listener                                                             |
| `ALLOWED_HOSTS`                                           | Loopback names and the HTTP port                  | Comma-separated browser host allowlist                                    |
| `APP_ORIGIN`                                              | Local request origin                              | Canonical public origin for stricter origin checks                        |
| `COOKIE_SECURE`, `TRUST_PROXY`                            | `false`, disabled                                 | HTTPS cookies and trusted proxy addresses or CIDRs                        |
| `MONGODB_URI`, `MONGODB_DB`                               | Local launcher, `nexora_servicedesk`              | MongoDB connection and database name                                      |
| `MONGO_PORT`, `DATA_DIR`                                  | `27271`, `.data`                                  | Local database listener and parent folder                                 |
| `DEMO_MODE`, `ALLOW_SELF_REGISTRATION`                    | `true`, `true`                                    | Sample credentials, demo clock and self-registration on the loopback demo |
| `APP_TIME_ZONE`                                           | `Asia/Kolkata`                                    | Display and report date boundaries                                        |
| `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD`, `COMPANY_DOMAIN` | Staff setup only, domain defaults to `nexora.com` | First staff administrator and organization domain                         |

Staff mode uses a separate database, `DEMO_MODE=false` and explicit first-administrator credentials. A public `APP_ORIGIN` must use HTTPS with Secure cookies and an external MongoDB connection. The Docker Compose configuration is for a loopback demonstration. See the [security notes](docs/security.md).

## Build and test

```sh
npm run build
npm test
npm run format:check
```

The tests use an isolated MongoDB replica set. The CI workflow runs the Node.js build and tests and builds the Docker image without publishing it.

## Project documentation

- [Project scope and requirements](docs/PROJECT.md)
- [Architecture](docs/architecture.md), [class diagrams](docs/class-diagram.md), [use cases](docs/use-case.md), and [MongoDB schema](docs/er-diagram.md)
- [Priority algorithms](docs/priority-algorithm.md) and [predictive SLA detection](docs/predictive-sla.md)
- [Security considerations](docs/security.md), [Technology Selection Report](docs/technology-report.md), and [test cases](docs/test-cases.md)
