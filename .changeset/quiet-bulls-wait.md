---
'@nest-batch/core': patch
'@nest-batch/bullmq': patch
---

Prevent BullMQ schedules with `overlap: 'skip'` from creating a new execution while the previous scheduled execution is still active, without dropping volatile schedule parameters such as `scheduledAt`.
