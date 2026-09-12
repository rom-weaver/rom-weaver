# Verify a download

Check the build provenance attached to a rom-weaver release archive, npm package, or container image. The install scripts run the first check automatically; use this page to verify a file by hand, to check the full signature, or to change how strict the install scripts are. Why the checks are shaped this way is covered in [Release provenance](../explanation/release-provenance.md).

<!-- START doctoc -->
## Table of contents

- [Verify a file you downloaded by hand](#verify-a-file-you-downloaded-by-hand)
- [Check the signature](#check-the-signature)
- [Control the install scripts' check](#control-the-install-scripts-check)

<!-- END doctoc -->

## Verify a file you downloaded by hand

Hash the file and query GitHub for this repository's SLSA build provenance for those bytes. This uses `curl` and a SHA-256 tool. It checks for a provenance record through GitHub's API; it does not validate the signature or restrict the signer to a particular workflow:

```bash
file=rom-weaver-linux-x64-gnu.tar.gz

# macOS ships shasum rather than sha256sum. Probe the command because a failed
# command in this pipeline can still leave the pipeline with a zero status.
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$file" | cut -d ' ' -f 1)
else
  digest=$(shasum -a 256 "$file" | cut -d ' ' -f 1)
fi

if curl -fsS "https://api.github.com/repos/rom-weaver/rom-weaver/attestations/sha256:$digest?predicate_type=https://slsa.dev/provenance/v1" \
  | grep -q '"repository_id"'
then
  echo "FOUND: rom-weaver repository build provenance"
else
  echo "NOT VERIFIED: no matching provenance or the query failed" >&2
fi
```

The PowerShell equivalent:

```powershell
$file = 'rom-weaver-win32-x64-msvc.tar.gz'
$digest = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLower()
$uri = "https://api.github.com/repos/rom-weaver/rom-weaver/attestations/sha256:${digest}" +
  '?predicate_type=https://slsa.dev/provenance/v1'
# GitHub returns 404 when no attestation exists. This script reports that and
# an unreachable API as NOT VERIFIED.
# Check for the property first: `@($null).Count` is 1, which would otherwise
# treat an unrelated successful response as verified.
$count = 0
try {
  $response = Invoke-RestMethod -Uri $uri
  if ($response.PSObject.Properties['attestations']) {
    $count = @($response.attestations).Count
  }
} catch { }
if ($count -gt 0) {
  Write-Host 'FOUND: rom-weaver repository build provenance'
} else {
  Write-Error 'NOT VERIFIED: no matching provenance or the query failed'
}
```

Keep the `predicate_type` filter: without it, a release-membership attestation can satisfy the query without any build provenance. [Why the predicate type filter is mandatory](../explanation/release-provenance.md#why-the-predicate-type-filter-is-mandatory) explains what the unfiltered query actually matches.

An asset from a release cut before provenance was added correctly reports NOT VERIFIED - there is no attestation to find. See [what build provenance proves](../explanation/release-provenance.md#what-build-provenance-proves).

## Check the signature

The queries above trust GitHub's API response over TLS. To validate the attestation signature and identity, use `gh` with the repository restriction. Sign in to `gh` before these network lookups:

```bash
gh attestation verify rom-weaver-linux-x64-gnu.tar.gz --repo rom-weaver/rom-weaver
gh attestation verify oci://ghcr.io/rom-weaver/rom-weaver-cli:latest \
  --repo rom-weaver/rom-weaver
```

These commands accept SLSA provenance from the named repository. To restrict the signer to a specific workflow, use `--signer-workflow` with the path that built that artifact. See the [GitHub CLI verification reference](https://cli.github.com/manual/gh_attestation_verify).

From a project directory containing the installed npm package, check package signatures and available provenance with:

```bash
npm audit signatures
```

## Control the install scripts' check

The install scripts run the digest query against the file they just downloaded. A definite negative stops the install; an unanswered question does not:

| Outcome | Behavior |
| --- | --- |
| This repository attested these bytes | installs |
| Nothing attested them - empty response or HTTP 404 | **refuses** |
| The check could not run - offline, rate-limited, 5xx | warns, installs |

[Why an unanswered check installs anyway](../explanation/release-provenance.md#why-an-unanswered-check-installs-anyway) covers the reasoning behind that last row. Every refusal prints the way past it:

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.sh |
  ROM_WEAVER_SKIP_ATTESTATION=1 sh
```

The assignment belongs on `sh`, not on `curl`: putting it at the front of the pipeline sets it for the download and not for the script that reads the variable, so the install refuses again.

Going the other way, `ROM_WEAVER_REQUIRE_ATTESTATION=1` promotes the could-not-run warning to a refusal too, so an install that could not be verified fails rather than proceeding.
