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

Add properties with Notion API type names. Leave out `propertyId`; `push` fills
it after Notion creates the property:

```json
{
  "properties": [
    { "key": "entryDate", "name": "Date", "type": "date" },
    {
      "key": "mood",
      "name": "Mood",
      "type": "select",
      "options": [
        { "name": "Great", "color": "green" },
        { "name": "Rough", "color": "red" }
      ]
    }
  ]
}
```

`config` is optional for these managed types. More complex properties preserve
their Notion configuration when pulled.

## Connect an existing source

Run the interactive setup from the project root:

```sh
npx tanstack-db-notion init
```

The CLI automatically loads `.env.local` and `.env`. When credentials are
missing, `init` asks for a PAT and exact data-source ID, single-source database
ID, or pasted Notion database URL. A prompted PAT and the resolved source ID are
stored in the gitignored `.env.local`; the source ID is also written to the
manifest and generated schema.

For a non-interactive coding agent or CI job, put `NOTION_PAT` in `.env.local`
and run `npx tanstack-db-notion init --id "<database URL or ID>"`. The resolved
source ID is saved even though it was supplied with a flag.

The default outputs are `notion.schema.json` and `src/notion.generated.ts`.
`--env`, `--manifest`, `--out`, `--id`, and `--name` remain available for
monorepos or custom layouts.

`doctor` is read-only. `init` inspects the source, writes the initial manifest,
and generates input and row types. Input omits read-only Notion fields; row
includes them. Review raw or unsupported fields in the
[property matrix](./PROPERTY_SUPPORT.md) before building mutations.

A database ID or URL is accepted only when it resolves to one source. If a
database has several sources, the CLI lists their names and IDs and stops
instead of guessing. Generated schemas retain the resolved ID; use
`resolveNotionDataSourceId()` when configuring a hand-written schema.

## Evolve a code-first source

Edit the manifest and follow one repeatable loop:

```sh
npx tanstack-db-notion push --dry-run
npx tanstack-db-notion push
npx tanstack-db-notion check
```

`push --dry-run` is inert. A real push applies supported additions and renames,
then pulls stable property IDs and regenerates types. Type changes or option
removals require `--accept-data-loss`; ask the data owner before using it. The
deprecated `--allow-destructive` alias emits a warning.

Use `generate` when you only need to refresh TypeScript without contacting
Notion. A successful `push` already regenerates it.

The adapter needs a stable rich-text sync key. For a new or existing source,
the default manifest calls it `Client ID`. A dry run warns when push will add
this visible column; review that change before applying it.

Property order follows the manifest, even when Notion returns another order,
so pull does not create noisy source diffs. Generated and manifest writes use
atomic replacement.

## Accept an intentional Notion-side change

When a person changes the data source in Notion, inspect and merge it:

```sh
npx tanstack-db-notion pull
npx tanstack-db-notion check
```

Review the manifest diff. Stable IDs distinguish a rename from a delete plus
addition. `check` is strict: it also reports properties that exist only in
Notion, exits non-zero on drift, and is suitable for CI. `push` never deletes
those Notion-only properties; use `pull` to add them to the manifest.

## CI contract

Commit the manifest and generated source, then run generation and fail if it
changes the working tree. Run `check` only in a trusted job with a read-capable
Notion token; never expose tokens to forked pull requests or browser builds.
