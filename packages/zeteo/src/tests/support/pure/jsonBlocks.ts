/** Every fenced ```json block in `text`, parsed, in order: the worked examples of a text meant for a model. */
export const jsonBlocks = (text: string): unknown[] =>
  [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    ([, body]) => JSON.parse(body!) as unknown
  );
