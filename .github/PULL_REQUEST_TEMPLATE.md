## Summary

Describe the problem and the focused change that solves it.

## Validation

List the checks you ran and any testing that remains. For a bug fix or anything
platform-specific, add:

- **Version and commit** you reproduced and verified against. `rom-weaver --version`
  prints the version alone, so pair it with `git rev-parse --short HEAD` for a
  source build. The webapp shows both beside the rom-weaver wordmark - hover it
  for the full build string.
- **Platform**: your OS, plus the browser for webapp changes.
- **Trace logs** for the failure and for the fix. `rom-weaver -vvv` writes them
  to stderr, and `--dep-trace` adds the bundled libraries. In the webapp, open
  the **Log** dialog from the masthead, set the level to `trace`, reproduce, then
  use its Download button - the level is a persisted setting, so it has to be
  raised before the run you want captured. Attach the logs as a file or a
  collapsed `<details>` block rather than inline.

## Screenshots

Anything with a visible effect - webapp UI, CLI output, generated reports -
needs a before and an after, as images or a short recording. Delete this
section when the change has none.

## Checklist

- [ ] The pull request title follows the [commit conventions](https://github.com/rom-weaver/rom-weaver/blob/main/docs/development/commits.md).
- [ ] Relevant tests and documentation are updated.
- [ ] No copyrighted ROMs, disc images, firmware, keys, or personal files are included.
- [ ] I have read the [contribution guide](https://github.com/rom-weaver/rom-weaver/blob/main/CONTRIBUTING.md) and [code of conduct](https://github.com/rom-weaver/rom-weaver/blob/main/.github/CODE_OF_CONDUCT.md).
- [ ] I have signed the [Contributor License Agreement](https://github.com/rom-weaver/rom-weaver/blob/main/CLA.md), or will when the `CLA Signed` check asks.
- [ ] Third-party code I did not write is identified above with its license and source, or this change contains none.
