# Schema workflow

The checked-in `notion.schema.json` manifest is the developer-owned contract.
The generated TypeScript file is disposable output, and the live Notion data
source is the external system being compared or changed. Keep the manifest and
generated file in source control; keep credentials in a server-only env file.

New manifests include the published JSON Schema URL for editor diagnostics:

```json
{
  "$schema": "https://unpkg.com/tanstack-db-notion-adapter/schema/notion.schema.json",
  "version": 1,
  "exportName": "projectSchema",
  "properties": []
}
```

The CLI validates the manifest before generation or any network request. It
rejects malformed fields, invalid TypeScript identifiers, generated export
name collisions, duplicate Notion names, and duplicate stable property IDs.

## Connect an existing source

Pass an exact data source ID, a single-source database ID, or paste the Notion
database URL directly into `--id`. The CLI resolves the concrete source and
writes it to the manifest:

```sh
npx tanstack-db-notion init \
  --env .env \
  --id "https://app.notion.com/p/workspace/..." \
  --manifest notion.schema.json \
  --out src/notion.generated.ts \
  --name projectSchema
```

`doctor` is read-only. `init` inspects the source, writes the initial manifest,
and generates both `ProjectSchemaInput` and `ProjectSchemaRow`. Input omits
read-only Notion fields; row includes them. Review raw or unsupported fields in
the [property matrix](./PROPERTY_SUPPORT.md) before building mutations.

A database ID or URL is accepted only when it resolves to one source. If a
database has several sources, the CLI lists their names and IDs and stops
instead of guessing. `resolveNotionDataSourceId()` provides the same behavior
for server setup.

## Evolve a code-first source

Edit the manifest and follow one repeatable loop:

```sh
npx tanstack-db-notion generate \
  --manifest notion.schema.json \
  --out src/notion.generated.ts
npx tanstack-db-notion push --dry-run \
  --env .env --manifest notion.schema.json
npx tanstack-db-notion push \
  --env .env --manifest notion.schema.json \
  --out src/notion.generated.ts
npx tanstack-db-notion check --env .env --manifest notion.schema.json
```

`push --dry-run` is inert. A real push applies supported additions and renames,
then pulls stable property IDs and regenerates types. Type changes or option
removals require `--accept-data-loss`; ask the data owner before using it. The
deprecated `--allow-destructive` alias emits a warning.

The adapter needs a stable rich-text sync key. For a new or existing source,
the default manifest calls it `Client ID`. A dry run warns when push will add
this visible column; review that change before applying it.

Property order follows the manifest, even when Notion returns another order,
so pull does not create noisy source diffs. Generated and manifest writes use
atomic replacement.

## Accept an intentional Notion-side change

When a person changes the data source in Notion, inspect and merge it:

```sh
npx tanstack-db-notion pull \
  --env .env --manifest notion.schema.json \
  --out src/notion.generated.ts
npx tanstack-db-notion check --env .env --manifest notion.schema.json
```

Review the manifest diff. Stable IDs distinguish a rename from a delete plus
addition. `check` exits non-zero on drift and is suitable for CI.

## CI contract

Commit the manifest and generated source, then run generation and fail if it
changes the working tree. Run `check` only in a trusted job with a read-capable
Notion token; never expose tokens to forked pull requests or browser builds.
