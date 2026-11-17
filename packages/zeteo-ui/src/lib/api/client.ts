import type { AxiosInstance } from "axios";
import { useApi } from "@tereo-io/react";

/** zeteo's name in the Tereo config's `apis`. It serves this UI, so its base is the page's origin. */
export const ZETEO_API = "zeteo";

/** zeteo's API client: sends the access token and renews it. */
export const useZeteoApi = (): AxiosInstance => useApi(ZETEO_API);
