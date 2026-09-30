# rom-weaver auth.md

## Audience and access

This document describes access for agents that use rom-weaver. The webapp and its URL session routes are public. There is no login. Agents and people use the same public routes without an account. ROM processing runs locally in the browser or through the native CLI. There is no server-side ROM processing API.

## Registration and provisioning

Agent registration and account provisioning are not required or supported. There are no registration, provisioning, or credential issuance endpoints. There are no supported registration methods. `/agent/auth` is not an endpoint.

## Credentials and OAuth

No API key, bearer token, password, or authentication cookie is required. rom-weaver does not issue or accept credentials for its public routes. There is no OAuth authorization server or protected resource metadata. Public access does not issue an anonymous agent credential.

## Integration discovery

- [API catalog](/.well-known/api-catalog)
- [OpenAPI description](/openapi.json)
- [Webapp integration guide](/docs/webapp-integration)

Remote input URLs remain subject to the source host's access and CORS rules.
