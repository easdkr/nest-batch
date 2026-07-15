---
'@nest-batch/core': patch
---

Register `@BatchScheduled` metadata during module initialization so scheduler adapters always see the complete registry regardless of Nest module bootstrap order.
