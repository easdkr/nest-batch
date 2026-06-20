# nest-batch Goal

## Implementation Progress

Implemented in the current pass:

- `JobExplorer` / `JobOperator` core operations:
  - list jobs, instances, executions
  - execution detail with step executions and contexts
  - stop, restart, abandon, start next instance
- Repository query contract and implementations for operator/explorer reads:
  - in-memory repository
  - generic TypeORM / MikroORM / Prisma / Drizzle repositories
  - PostgreSQL and MySQL driver-specific TypeORM / Prisma / Drizzle repositories
- Restartable chunk component lifecycle via `ItemStream`:
  - `open(context)`
  - `update(context)`
  - `close()`
- Flow transition matching:
  - custom exit-code transition keys
  - `*` and `?` wildcard matching
  - exact-match precedence over wildcard matches
- Worker execution foundation:
  - `BatchWorkerRunner`
  - `parseBatchWorkerArgs`
  - process exit-code mapping
- SDK-agnostic one-off runtime foundation:
  - `ExternalTaskExecutionStrategy`
  - `ExternalTaskLauncher` contract
  - worker args/env/label propagation for container/job adapters
- Cloud/runtime integration packages:
  - `@nest-batch/aws-ecs` with ECS Fargate `RunTask` launcher
  - `@nest-batch/kubernetes` with Kubernetes Job launcher
  - `@nest-batch/aws-batch` with AWS Batch `SubmitJob` launcher
  - `@nest-batch/aws-sqs` with SQS/FIFO execution strategy
  - `@nest-batch/aws-eventbridge-scheduler` with EventBridge Scheduler installer
- Built-in restartable reader/writer starter kit:
  - restartable file line, CSV, and JSONL readers
  - JSONL and CSV file writers
  - S3 JSONL object reader and chunked JSONL writer
  - database paging/cursor readers and batch writer helper
- Flow decision APIs:
  - `JobExecutionDecider` / `DeciderDefinition`
  - decider-driven transition routing in `JobExecutor`
  - reusable flow bundles through `defineReusableFlow()` and `JobBuilder.useFlow()`
- Operations surface:
  - `@nest-batch/admin` with Nest controller JSON APIs and lightweight HTML dashboard
  - core observability exporters for composite fan-out, JSON log lines, and Prometheus text metrics
  - `@nest-batch/deployment` with IaC/deployment recipes and IAM/RBAC helper objects

Validated:

- `pnpm -r exec tsc --noEmit`
- `pnpm -r test`
- `pnpm -r build`
- source/package non-document search for forbidden framework wording under `packages/` and `apps/`

Still remaining:

- No implementation items remain from this goal. Live cloud smoke tests still require real AWS/Kubernetes credentials and runtime resources.

## Direction

`nest-batch` should not try to clone all of Spring Batch. The practical target is:

> Spring Batch-compatible mental model + Nest-native operations + cloud-native runtime adapters.

Follow Spring Batch where it defines durable batch semantics: job/step metadata, restart, checkpoint, skip/retry, listeners, execution context, and operator APIs. Differentiate where Nest and modern infrastructure matter: AWS, Kubernetes, queue runtimes, observability, deployment topology, and TypeScript-friendly DX.

## 1. Batch Feature Additions

These are the Spring Batch parity areas that matter in production.

### 1.1 Job Operator / Explorer

- Add `JobOperator` as the main operational API.
- Add `JobExplorer`-style query APIs, or fold them into `JobRepository` if that keeps the surface smaller.
- Support:
  - list jobs
  - list job instances
  - list executions by job / status / time range
  - get execution detail with steps and execution context
  - stop execution
  - restart failed/stopped execution
  - abandon execution
  - start next instance
- Keep `JobRepository` as canonical state; queue/task state is only correlation data.

### 1.2 Restartable Component Lifecycle

- Add an `ItemStream`-like lifecycle for stateful readers/writers:
  - `open(context)`
  - `update(context)`
  - `close()`
- Use it for restartable file readers, cursor readers, paging readers, and partition readers.
- Persist reader/writer progress through `ExecutionContext`, not process memory.
- Define failure behavior for lifecycle hook errors.

### 1.3 Flow Semantics

- Extend flow transition matching beyond exact status equality.
- Support wildcard exit-code matching such as `*` and `?`.
- Add custom `ExitStatus` separate from raw execution status.
- Add `JobExecutionDecider`-style programmatic decisions.
- Add reusable flow definitions.
- Defer parallel split flows until the runtime model is clearer.

### 1.4 Fault Tolerance

- Improve skip/retry semantics around read/process/write phases.
- Add no-rollback / rollback classification.
- Add retry exhaustion events and richer failure context.
- Define whether retry is per item, per chunk, per step, or transport attempt.
- Keep business retry in core and infrastructure retry in transport adapters.

### 1.5 Built-In Reader / Writer Starter Kit

Do not copy Spring Batch's full reader/writer catalog. Add a focused, production-useful starter kit:

- CSV/file reader with restart support
- JSONL reader
- database paging reader
- database cursor reader where the ORM supports it safely
- S3 object reader
- S3 object writer
- JDBC/ORM batch writer equivalents for supported adapters
- composite processor/writer helpers

### 1.6 Test Contracts

- Expand adapter contract tests beyond repository/transaction.
- Add contracts for:
  - restart behavior
  - execution context versioning
  - stop/restart/abandon operator behavior
  - partition execution invariants
  - stream lifecycle behavior
  - transport retry vs business retry separation

## 2. Infrastructure Integration

These are cloud/runtime integrations that should make `nest-batch` useful beyond Spring Batch parity.

### 2.1 Ephemeral Compute Runners

Support "run a container for this batch, exit when done" as a first-class execution strategy.

Targets:

- ECS Fargate one-off task
- Kubernetes Job
- AWS Batch job / array job

Base behavior:

- `JobLauncher.launch()` creates a `JobExecution`.
- Adapter starts a Fargate task / Kubernetes Job / AWS Batch job.
- Runtime passes `jobId`, `jobExecutionId`, `stepId`, and optional `partitionIndex`.
- Container starts in `batch-worker` mode.
- Worker runs `JobExecutor`.
- Worker writes terminal status to `JobRepository`.
- Infrastructure resource exits naturally.

Start with one container per `JobExecution`. Add one container per partition after the operator/restart model is stable.

### 2.2 AWS SQS Transport

- Add `@nest-batch/aws-sqs`.
- Map step or partition work to SQS messages.
- Support FIFO queues:
  - `MessageGroupId` from job/step/partition key
  - `MessageDeduplicationId` from execution identity
- Handle visibility timeout extension for long-running steps.
- Support DLQ correlation and redrive/replay helpers.
- Keep SQS message id as correlation data only.

### 2.3 EventBridge Scheduler

- Add `@nest-batch/aws-eventbridge-scheduler`.
- Map `@BatchScheduled` entries to EventBridge Scheduler schedules.
- Support:
  - schedule group
  - timezone
  - flexible time window
  - retry policy
  - DLQ
  - target selection: SQS, ECS RunTask, Lambda, or API destination
- Keep local/in-process scheduler optional for tests and development.

### 2.4 ECS / Fargate Adapter

- Add an `EcsFargateExecutionStrategy`.
- Use `RunTask` for one-off execution.
- Support:
  - cluster
  - task definition
  - container overrides
  - command/env injection
  - subnet/security group config
  - capacity provider: `FARGATE` / `FARGATE_SPOT`
  - task tags with execution ids
- Add task-state watcher:
  - launch failure
  - task stopped before worker boot
  - container exit code mapping
  - timeout and orphan detection

### 2.5 Kubernetes Job Adapter

- Add `KubernetesJobExecutionStrategy`.
- Create a Kubernetes `Job` per execution or partition.
- Support:
  - namespace
  - image
  - service account
  - env/args injection
  - labels/annotations with execution ids
  - resource requests/limits
  - `backoffLimit`
  - `activeDeadlineSeconds`
  - `ttlSecondsAfterFinished`
- Add watcher for Job/Pod terminal states.

### 2.6 AWS Batch Adapter

- Add after ECS/Kubernetes runner is proven.
- Map partitioned steps to AWS Batch array jobs.
- Use AWS Batch retry only for infrastructure/container failure.
- Keep business skip/retry in core.

### 2.7 Observability

- Add CloudWatch EMF support.
- Add OpenTelemetry exporter package.
- Emit:
  - job duration
  - step duration
  - active jobs/steps
  - read/write/skip/retry counts
  - partition index/count
  - queue lag
  - worker cold-start time
  - task/pod launch latency
- Propagate trace/correlation fields:
  - `jobExecutionId`
  - `stepExecutionId`
  - `partitionIndex`
  - queue message id
  - ECS task ARN / Kubernetes pod UID

### 2.8 CDK / IaC Constructs

- Provide CDK constructs matching runtime modules.
- Generate:
  - SQS queue + DLQ
  - EventBridge schedules
  - ECS task definition and IAM role
  - ECS worker service or RunTask permissions
  - CloudWatch log group
  - dashboard and alarms
  - optional RDS permissions/secrets
- Goal: code-level batch topology and deployed AWS resources should not drift silently.

## 3. nest-batch Unique Integration Areas

These are the features that make this package more than "Spring Batch in TypeScript".

### 3.1 Unified Runtime Contract

- Keep all runtimes behind `IExecutionStrategy`.
- Supported runtime styles:
  - in-process
  - queue worker
  - one-off container
  - partition fan-out
  - scheduled launch
- Make the execution state model identical across all runtimes.

### 3.2 Worker Entrypoint

- Add an official `batch-worker` bootstrap mode.
- Example:
  - `node dist/main.js batch-worker --execution-id=...`
  - `node dist/main.js batch-worker --job-id=... --params-json=...`
- Worker should:
  - boot Nest context
  - load `JobExecution`
  - resolve `JobDefinition`
  - run `JobExecutor`
  - write terminal status
  - exit with meaningful code

### 3.3 Admin API / UI

- Add an optional admin package.
- API first, UI second.
- Functions:
  - list jobs/executions
  - inspect step counts and errors
  - view execution context
  - stop/restart/abandon
  - redrive DLQ/correlation links
  - link to CloudWatch/ECS/Kubernetes resources

### 3.4 Event Bus and Webhook Layer

- Keep `BatchObserver` as the extension point.
- Add fan-out observers:
  - webhook
  - CloudWatch EMF
  - OpenTelemetry
  - SNS/EventBridge event publisher
- Observer failure must not corrupt batch state.

### 3.5 Idempotency and Locking

- Make idempotency explicit in public docs and APIs.
- Provide helpers for:
  - deterministic job key
  - duplicate launch handling
  - idempotent writer patterns
  - partition output naming
  - S3 object commit/rename pattern
- Document requirements for at-least-once queues and container retries.

### 3.6 Deployment Recipes

Ship reference patterns:

- API-only launcher + SQS workers
- API-only launcher + ECS one-off tasks
- EventBridge schedule + ECS one-off task
- EventBridge schedule + SQS queue + autoscaled workers
- Kubernetes Job per execution
- AWS Batch array job for partitioned workloads

## 4. Suggested Roadmap

### Phase 1: Production Operations Core

- `JobOperator`
- `JobExplorer` query API
- stop/restart/abandon
- execution detail model
- better failure context
- restart contracts

### Phase 2: Restartable IO and Flow

- `ItemStream` lifecycle
- restartable CSV/JSONL/S3 readers
- database paging reader
- custom exit status
- wildcard flow matching
- decider support

### Phase 3: AWS Runtime Foundation

- `@nest-batch/aws-sqs`
- `@nest-batch/aws-eventbridge-scheduler`
- `@nest-batch/aws-ecs-fargate`
- official `batch-worker` entrypoint
- CloudWatch EMF observer

### Phase 4: Ephemeral / Partition Compute

- Kubernetes Job adapter
- partition-per-task fan-out
- watcher/reconciler for task and pod states
- AWS Batch adapter with array jobs

### Phase 5: Operator Experience

- Admin REST API
- Admin UI
- CDK constructs
- dashboards and alarms
- deployment recipes

## 5. Non-Goals For Now

- Full Spring Batch clone.
- XML DSL.
- Every Spring Batch reader/writer implementation.
- Generic scheduler competing with EventBridge/Quartz.
- Step Functions as the primary execution engine.
- Deep Java transaction semantics copied 1:1.
- Admin UI before the operator/query API is stable.
