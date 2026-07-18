# Gateway Configuration and Secret Separation Design

## Goal

Use `clients.*.endpoints` as the only routing configuration, give every endpoint
a stable globally unique ID, and store endpoint credentials in an ignored
`gateway.secrets.json` file keyed by endpoint ID.

## Canonical files

`gateway.config.json` is safe to commit and contains only:

- `server`
- `clients.<client>.endpoints`
- endpoint routing, model, capability, and display fields

`gateway.secrets.json` is ignored and has this shape:

```json
{
  "api_keys": {
    "ep_550e8400-e29b-41d4-a716-446655440000": "env:ARK_API_KEY",
    "ep_7c8b91e1-43cd-4dc7-bd13-7ca32a511cee": "sk-local-secret"
  }
}
```

Both literal keys and `env:NAME` references live in the secret file. Runtime
configuration returned by HTTP never includes secret values.

## Endpoint IDs

New endpoints receive `ep_${crypto.randomUUID()}`. IDs are immutable in the UI,
independent of endpoint names and URLs, and globally unique across all clients.
The server rejects missing or duplicate IDs on save. Legacy endpoints receive
IDs during automatic migration.

## Automatic migration

On first load:

1. Read the existing config and secrets.
2. If `clients` is absent, convert legacy `providers` and `models` into client
   endpoints using the existing compatibility rules.
3. Add IDs to endpoints that lack them.
4. Move every endpoint `api_key` value into `gateway.secrets.json`.
5. Remove `providers`, `models`, and `official_models`.
6. Before writing, create a timestamped `.bak` copy of the original config.
7. Write the secret file with restrictive permissions and write the canonical
   config without credentials.

Saving from the UI performs the same extraction. An unchanged save does not
rewrite either file.

## Routing and model visibility

Each client may have at most one `is_default` endpoint. It remains the fallback
route for requests that have no explicit model match.

`expose_models` controls model-list visibility:

- If one or more endpoints have `expose_models: true`, expose only those.
- If no endpoint has it enabled, expose every endpoint.

Claude Desktop synchronization aggregates models from all selected Desktop
endpoints. The Codex catalog applies the same selection rule.

## Model conflicts

For each client, public model IDs are the union of:

- values in `endpoint.models`
- keys in `endpoint.model_mapping`

Every public ID must be unique, including within one endpoint. Mapping values
may repeat because they are upstream model names.

Saving rejects conflicts and reports every conflicting endpoint and source.
For each conflict it proposes a public name based on the endpoint name:
`<model-id>-<slugified-endpoint-name>`. If that still conflicts, a short suffix
from the endpoint ID is appended. Codex custom IDs also remain forbidden from
colliding with official Codex IDs.

## UI and observability

The configuration panel:

- creates endpoint IDs automatically and displays them read-only
- shows whether a credential is configured without receiving its value
- accepts a replacement credential and sends it only during save
- allows independent `is_default` and `expose_models` controls
- displays server-provided conflict details and candidate names

Configuration saves log a credential-free audit event containing the caller,
changed files, and whether migration occurred. Background startup must not open
the browser when `GATEWAY_NO_OPEN=1`.

## Verification

Tests cover migration and backup, credential extraction and lookup, stable IDs,
duplicate rejection and suggestions, exposure fallback, Claude aggregation,
Codex filtering, unchanged-save behavior, and HTTP save behavior. Existing
unit, Desktop, adapter, integration, and local E2E suites must remain green.
