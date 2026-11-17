import { useParams } from "react-router-dom";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The route parameter `name` in lower case, or undefined when it is absent or not a UUID. */
export const useUuidParam = (name: string): string | undefined => {
  const value = useParams()[name];
  return value !== undefined && UUID.test(value)
    ? value.toLowerCase()
    : undefined;
};
