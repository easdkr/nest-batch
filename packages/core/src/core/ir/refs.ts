export enum RefKind {
  ProviderToken = 'provider-token',
  BuilderLambda = 'builder-lambda',
  Method = 'method',
}

export interface ReaderRef {
  kind: RefKind;
  token?: string;
  fn?: (...args: any[]) => unknown;
  classToken?: string;
  methodName?: string;
}
export interface ProcessorRef {
  kind: RefKind;
  token?: string;
  fn?: (...args: any[]) => unknown;
  classToken?: string;
  methodName?: string;
}
export interface WriterRef {
  kind: RefKind;
  token?: string;
  fn?: (...args: any[]) => unknown;
  classToken?: string;
  methodName?: string;
}
export interface TaskletRef {
  kind: RefKind;
  token?: string;
  fn?: (...args: any[]) => unknown;
  classToken?: string;
  methodName?: string;
}
export interface ListenerRef {
  kind: RefKind;
  token?: string;
  fn?: (...args: any[]) => unknown;
  classToken?: string;
  methodName?: string;
}
export type ItemListenerRef = ListenerRef;
