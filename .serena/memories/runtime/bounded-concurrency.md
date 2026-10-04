# runtime — bounded-concurrency

Keywords: comply.mts, runPass, scheduler, bounded concurrency, needs, uses, shared resources, consumer-command, deterministic reports, blocked, cancellation, AbortSignal, SIGINT, DEFINED_CONCURRENCY, issue 70
What: how the gate's verification pass fans out (#70) — repair stays sequential, verification runs a bounded scheduler (needs/uses), reports stay deterministic in step order, and SIGINT/SIGTERM cancel via the runner's AbortSignal → docs/runtime/bounded-concurrency.md
