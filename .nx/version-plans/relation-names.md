---
zeteo: major
"@zeteo-io/sdk": minor
---

Discovered relations are renamed at the next refresh of each source: a foreign key to a table that has no other key to the same table is named after the target table (`customers`, not `customer`), and keys named by their column lose the table's column prefix and one key suffix. Queries and declared joins that use the old names must change. `PATCH /v1/sources/{sourceId}/relations/{relationId}` (SDK: `sources.relations.update`) renames a relation; a renamed discovered relation keeps its name across refreshes.
