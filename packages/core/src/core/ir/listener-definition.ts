import type { ListenerRef } from './refs';

export type ListenerKind =
  | 'job'
  | 'step'
  | 'chunk'
  | 'item-read'
  | 'item-process'
  | 'item-write'
  | 'skip'
  | 'transition';
export type ListenerPhase = 'before' | 'after' | 'on-error';
export type SkipSubKind = 'read' | 'process' | 'write';

export interface ListenerDefinition {
  kind: ListenerKind;
  ref: ListenerRef;
  phase: ListenerPhase;
  skipKind?: SkipSubKind;
  nonCritical?: boolean;
}
