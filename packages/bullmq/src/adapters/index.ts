/**
 * Public surface for the BullMQ adapter factory.
 *
 * The `BullmqAdapter` is the only entry point the host should
 * depend on for the new factory-pattern API. The internal module
 * class (`BullmqModule`) is exported alongside it as a NestJS
 * identifier — it is safe to reference from test code that needs
 * to assert on the `module` field of the adapter value, but it
 * has no runtime surface beyond the empty class body.
 */
export * from './bullmq.adapter';
