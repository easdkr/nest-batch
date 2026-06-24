import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { CronJob } from 'cron';

import { type BatchScheduleEntry, BatchScheduleRegistry } from '../module/batch-schedule-registry';
import { JobLauncher } from './job-launcher';

interface ScheduleState {
  readonly entry: BatchScheduleEntry;
  readonly job: CronJob;
  runningCount: number;
  queued: boolean;
  queuedAt: Date | null;
}

function scheduleKey(entry: BatchScheduleEntry): string {
  return `${entry.jobId}::${entry.scheduleName}`;
}

/**
 * In-process scheduler for `@BatchScheduled` jobs.
 *
 * This is deliberately part of the in-process transport, not the
 * `@BatchScheduled` decorator. The decorator remains metadata-only;
 * this provider consumes the `BatchScheduleRegistry` and turns matching
 * cron ticks into `JobLauncher.launch(...)` calls inside the same server
 * process.
 */
@Injectable()
export class InProcessSchedule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(InProcessSchedule.name);
  private readonly states = new Map<string, ScheduleState>();
  private stopped = true;

  constructor(
    private readonly scheduleRegistry: BatchScheduleRegistry,
    private readonly launcher: JobLauncher,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    for (const entry of this.scheduleRegistry.getAll()) {
      if (entry.inert) {
        this.logger.log(`Skipping inert schedule: ${entry.jobId}::${entry.scheduleName}`);
        continue;
      }

      try {
        let state!: ScheduleState;
        const job = CronJob.from({
          cronTime: entry.cron,
          timeZone: entry.timezone,
          start: false,
          unrefTimeout: true,
          name: scheduleKey(entry),
          errorHandler: (err) => {
            this.logger.warn(
              `In-process schedule ${scheduleKey(entry)} callback failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          },
          onTick: () => {
            if (this.stopped) return;
            this.dispatch(state, state.job.lastDate() ?? new Date());
          },
        });
        state = {
          entry,
          job,
          runningCount: 0,
          queued: false,
          queuedAt: null,
        };
        this.states.set(scheduleKey(entry), state);
        job.start();
      } catch (err) {
        this.logger.warn(
          `Failed to install in-process schedule ${entry.jobId}::${entry.scheduleName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (this.states.size === 0) return;

    this.logger.log(`InProcessSchedule started: schedules=${this.states.size}`);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    for (const state of this.states.values()) {
      void state.job.stop();
    }
    this.states.clear();
  }

  private dispatch(state: ScheduleState, scheduledAt: Date): void {
    if (this.stopped) return;
    const overlap = state.entry.overlap ?? 'skip';
    if (state.runningCount > 0) {
      if (overlap === 'skip') return;
      if (overlap === 'queue') {
        state.queued = true;
        state.queuedAt ??= scheduledAt;
        return;
      }
    }

    state.runningCount += 1;
    void this.launch(state, scheduledAt).finally(() => {
      state.runningCount -= 1;
      if (this.stopped) return;
      if (state.runningCount === 0 && state.queued) {
        state.queued = false;
        const queuedAt = state.queuedAt ?? new Date();
        state.queuedAt = null;
        this.dispatch(state, queuedAt);
      }
    });
  }

  private async launch(state: ScheduleState, scheduledAt: Date): Promise<void> {
    const { entry } = state;
    try {
      const execution = await this.launcher.launch(entry.jobId, {
        scheduled: true,
        scheduleName: entry.scheduleName,
        scheduledAt: scheduledAt.toISOString(),
      });
      this.logger.log(
        `Fired schedule ${entry.jobId}::${entry.scheduleName} -> ` +
          `execution=${execution.id} status=${execution.status}`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to fire schedule ${entry.jobId}::${entry.scheduleName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
