/** A slug suggested from a name: "Larkspur Retail" → "larkspur-retail". At most 63 characters, never ending in a hyphen. */
export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
