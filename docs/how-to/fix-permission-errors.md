<!-- START doctoc --> <!-- END doctoc -->

# Fix a permission error

Get past a `Permission denied` error from the CLI. The message itself carries what you need: what was refused, who owns it, and who asked - [File permissions](../reference/cli.md#file-permissions) explains the format and when the checks run.

```text
error: i/o error: cannot open `/roms/game.iso`: Permission denied (os error 13)
(`/roms/game.iso` is mode 0600 owned by 0:0; this process runs as 1000:1000)
```

Match your situation:

- **Reading someone else's files.** `sudo chown` them, add yourself to the owning group, or copy them somewhere you own.
- **Writing to a read-only location.** Point `--output` at a directory you own. rom-weaver creates missing output directories but never changes permissions on an existing one.
- **Output files owned by the wrong user.** New files inherit your identity and umask; rom-weaver does not copy the source file's mode.
- **Inside a container.** The message adds a container hint, because the usual cause is a uid mismatch against a bind mount. Re-run with `--user "$(id -u):$(id -g)"` as shown in [Run in Docker](install-cli.md#run-in-docker).
