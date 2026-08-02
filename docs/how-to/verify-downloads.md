# Verify a download

Check that a rom-weaver artifact you downloaded - a release archive, an npm
package, or a container image - was built by this repository's release
workflow. The install scripts run the first check automatically; use this page
to verify a file by hand, to check the full signature, or to change how strict
the install scripts are. Why the checks are shaped this way is covered in
[Release provenance](../explanation/release-provenance.md).

<!-- START doctoc -->
## Table of contents

- [Verify a file you downloaded by hand](#verify-a-file-you-downloaded-by-hand)
- [Check the signature](#check-the-signature)
- [Control the install scripts' check](#control-the-install-scripts-check)

<!-- END doctoc -->

## Verify a file you downloaded by hand

Hash the file and ask GitHub whether this repository's release workflow built
exactly those bytes. Nothing needs installing - this is the same check both
install scripts run:

```bash
file=rom-weaver-linux-x64-gnu.tar.gz

# sha256sum on Linux; macOS ships shasum instead. Probed rather than tried and
# fallen back from: `$(missing | cut)` exits 0, so a fallback keyed on the exit
# status never runs and the digest silently comes out empty.
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$file" | cut -d ' ' -f 1)
else
  digest=$(shasum -a 256 "$file" | cut -d ' ' -f 1)
fi

if curl -fsS "https://api.github.com/repos/rom-weaver/rom-weaver/attestations/sha256:$digest?predicate_type=https://slsa.dev/provenance/v1" \
  | grep -q '"repository_id"'
then
  echo "VERIFIED: built by the rom-weaver release workflow"
else
  echo "NOT VERIFIED: no build provenance covers this file" >&2
fi
```

The PowerShell equivalent:

```powershell
$file = 'rom-weaver-win32-x64-msvc.tar.gz'
$digest = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLower()
$uri = "https://api.github.com/repos/rom-weaver/rom-weaver/attestations/sha256:${digest}" +
  '?predicate_type=https://slsa.dev/provenance/v1'
# A repository with no attestations at all answers 404, which Invoke-RestMethod
# raises rather than returns - uncaught, it ends the script before the
# not-verified message it was written for. Unlike the install scripts, this does
# not tell that apart from an unreachable API; both report NOT VERIFIED here.
# The property is checked before it is read because `@($null).Count` is 1, so
# reading a missing one blind would count an unrelated 200 as verified.
$count = 0
try {
  $response = Invoke-RestMethod -Uri $uri
  if ($response.PSObject.Properties['attestations']) {
    $count = @($response.attestations).Count
  }
} catch { }
if ($count -gt 0) {
  Write-Host 'VERIFIED: built by the rom-weaver release workflow'
} else {
  Write-Error 'NOT VERIFIED: no build provenance covers this file'
}
```

Keep the `predicate_type` filter: without it the check passes on files the
release workflow never built.
[Why the predicate type filter is mandatory](../explanation/release-provenance.md#why-the-predicate-type-filter-is-mandatory)
explains what the unfiltered query actually matches.

An asset from a release cut before provenance was added correctly reports NOT
VERIFIED - there is no attestation to find. See
[what build provenance proves](../explanation/release-provenance.md#what-build-provenance-proves).

## Check the signature

The queries above trust GitHub's API response over TLS. To check the Sigstore
signature itself - signature, certificate chain, and transparency-log
inclusion - use `gh`, which must be signed in even for a public repository:

```bash
gh attestation verify rom-weaver-linux-x64-gnu.tar.gz --repo rom-weaver/rom-weaver
gh attestation verify oci://ghcr.io/rom-weaver/rom-weaver-cli:latest \
  --repo rom-weaver/rom-weaver
```

npm packages carry their own provenance, verified with:

```bash
npm audit signatures
```

## Control the install scripts' check

The install scripts run the digest query against the file they just
downloaded. A definite negative stops the install; an unanswered question does
not:

| Outcome | Behavior |
| --- | --- |
| This repository attested these bytes | installs |
| Nothing attested them - empty response or HTTP 404 | **refuses** |
| The check could not run - offline, rate-limited, 5xx | warns, installs |

[Why an unanswered check installs anyway](../explanation/release-provenance.md#why-an-unanswered-check-installs-anyway)
covers the reasoning behind that last row. Every refusal prints the way past
it:

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.sh |
  ROM_WEAVER_SKIP_ATTESTATION=1 sh
```

The assignment belongs on `sh`, not on `curl`: putting it at the front of the
pipeline sets it for the download and not for the script that reads the
variable, so the install refuses again.

Going the other way, `ROM_WEAVER_REQUIRE_ATTESTATION=1` promotes the
could-not-run warning to a refusal too, so an install that could not be
verified fails rather than proceeding.
