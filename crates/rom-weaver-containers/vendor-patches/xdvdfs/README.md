# xdvdfs patch queue

The manifest pins the published 0.8.3 crate and its registry checksum. Its normalized root is the archive's `src` directory. The archive omits a license file; `LICENSE` is preserved from the committed vendor tree, as is `XDVDFS_VERSION`.

Patch 0001 isolates traversal-cycle guards and the error they return. Patch 0002 disables the unused remap module, matching the outcome of merged upstream [PR #189](https://github.com/antangelo/xdvdfs/pull/189) with remap off. Patches 0003–0007 inline the library, one concern each: lib.rs→mod.rs and path rewrites, resolved features with disabled logging, proc-bitfield repr compatibility, edition/lint compatibility, and existing test adaptations. The existing omission of two futures-dependent layout tests is reproduced rather than introduced by this task; the manifest does not change test dependencies.

Upstream status reflects the public audit dated 2026-10-15; `no-submission-found` records no matching public cycle-guard submission found in that audit. Per-patch test commands are related checks, not a claim that behavioral tests ran in this task.
