---
'@nest-batch/mikro-orm': patch
---

Read step executions from the primary connection before updating them to avoid read-replica lag races after creation.
