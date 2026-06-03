import type { ReaderRef, ProcessorRef, WriterRef, TaskletRef, ItemListenerRef } from './refs';
import type { SkipPolicyConfig, RetryPolicyConfig } from './policy-config';

export type StepDefinition = ChunkStepDefinition | TaskletStepDefinition;

export interface ChunkStepDefinition {
  kind: 'chunk';
  id: string;
  chunkSize: number;
  reader: ReaderRef;
  processor?: ProcessorRef;
  writer: WriterRef;
  skipPolicy?: SkipPolicyConfig;
  retryPolicy?: RetryPolicyConfig;
  listeners: ItemListenerRef[];
}

export interface TaskletStepDefinition {
  kind: 'tasklet';
  id: string;
  tasklet: TaskletRef;
  listeners: ItemListenerRef[];
}
