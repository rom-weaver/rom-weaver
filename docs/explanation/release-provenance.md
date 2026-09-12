# Release provenance

Why rom-weaver downloads can be verified, what that verification actually proves, and why the checks are shaped the way they are. The steps themselves live in [Verify a download](../how-to/verify-downloads.md); nothing here is a procedure.

<!-- START doctoc -->
## Table of contents

- [What build provenance proves](#what-build-provenance-proves)
- [Why the predicate type filter is mandatory](#why-the-predicate-type-filter-is-mandatory)
- [Why there is no `.sha256` sidecar](#why-there-is-no-sha256-sidecar)
- [Why the install scripts skip `gh` and `cosign`](#why-the-install-scripts-skip-gh-and-cosign)
- [Why an unanswered check installs anyway](#why-an-unanswered-check-installs-anyway)

<!-- END doctoc -->

## What build provenance proves

The release workflows attach signed [build provenance][slsa] to platform archives, the webapp tarball, npm packages, and container images. Provenance records the build identity and source commit. Uploading a file to a release does not create this build record.

The install scripts query GitHub for this repository's SLSA record for the downloaded digest. They trust the API response over TLS. They do not validate the signature locally or require a particular workflow identity. A signature check can add those restrictions. Provenance describes where an artifact came from; it does not establish that its code is correct.

Because it is the release workflow's own attestation, it only exists for releases cut after provenance was added. Verifying an asset from an earlier release correctly reports NOT VERIFIED - there is no build provenance to find.

## Why the predicate type filter is mandatory

Immutable releases make GitHub attest every release automatically, and that attestation lists the digest of every asset in it - so an unfiltered query returns a hit for any file in any release, and the check passes on files nothing built. That automatic attestation only says "this was in release X," which is also true of an asset a stolen token uploaded to the draft. Filtering to SLSA provenance excludes release-membership records. Restricting the signer to a particular workflow is a separate check.

## Why there is no `.sha256` sidecar

Altered bytes hash to something no attestation covers, so the provenance check refuses them - which is why no `.sha256` sidecar is published any more. A sidecar could not have added anything, having shipped from the same place as the binary: an attacker who can replace the download can replace the sidecar beside it.

## Why the install scripts skip `gh` and `cosign`

The digest query trusts GitHub's API response over TLS, which is the same trust the download itself already places in GitHub. Checking the Sigstore signature, certificate chain, and transparency-log inclusion needs `gh` or `cosign` - and requiring a tool most machines lack, in order to install a tool, is not a trade worth making in a `curl | sh`. Online `gh` queries also need authentication. The stronger check stays available to anyone who wants it: [Check the signature](../how-to/verify-downloads.md#check-the-signature).

## Why an unanswered check installs anyway

The unauthenticated GitHub API allows 60 requests an hour per address, so "the check could not run" is reachable by ordinary use rather than only by attack. That is why the scripts warn and install on an unreachable or rate-limited API, while a definite "nothing attested these bytes" always refuses. `ROM_WEAVER_REQUIRE_ATTESTATION=1` turns that warning into a refusal when verification is required.

[slsa]: https://slsa.dev/spec/v1.0/provenance
