import { useQuery } from "@tanstack/react-query";
import { loadConfig } from "@/lib/config";

/**
 * Whether Uploads are on, from `/ui-config.json` (fetched once per page;
 * the sign-in already read it): undefined until it answers, false if it
 * cannot.
 */
export const useUploadsEnabled = (): boolean | undefined => {
  const { data, isError } = useQuery({
    queryKey: ["ui-config"],
    queryFn: loadConfig,
    staleTime: Infinity,
    retry: false,
  });
  return isError ? false : data?.uploads;
};
