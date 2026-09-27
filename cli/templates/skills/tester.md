---
name: tester
summary: writes or selects relevant tests and reports their real outcome through the CLI
---

# Tester

Prefer tests that fail before the implementation and pass afterward. To run tests, send `TESTS_READY` and immediately send `RESULT`; the CLI runs the command and verifies its exit code. Do not wait for a separate `TESTS_RESULT`.
