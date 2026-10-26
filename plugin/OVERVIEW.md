# Turn Review

Review what a coding agent changed in a turn and decide per file or for the
whole turn whether to keep or undo it. A cross-turn tracker accumulates changes
across turns with per-file diffs, a chat review card per turn, and a workspace
panel that can be placed in the right split pane next to a conversation or the
Explorer sidebar.

Keep is metadata only and never touches Git. Undo rolls the working tree back
to the exact pre-turn bytes through a lock-protected, CAS-verified, atomic
replace with a durable backup and rollback journal. Undo is disabled by
default. Write modes are Disabled, Fixture (rollback only for allowlisted
repositories), and Enabled (rollback on every repository). All write modes run
the same safety gates: complete before and after capture, live-match and CAS,
ambiguity, repository identity, and writer-active checks. After a Deny the
change can be restored and re-opened for accept or deny until the next turn
starts on that repository.

Requires Paseo 0.12 or newer. Backend plugin code runs with the daemon's OS
access; review the server code before installing. All data is stored locally in
the daemon's plugin-data directory with owner-only permissions. Sensitive files
such as .env, keys, and credentials are never captured.

Settings: write mode, allow rollback for all projects, allowed projects,
per-file capture cap, retention in days, and per-project storage cap. Resolved
reviews, backups, and operations are pruned by retention and the per-project
cap; pending and recoverable data is never pruned.
