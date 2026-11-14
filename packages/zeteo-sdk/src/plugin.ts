import { registerZeteoTemplate, ZETEO_TEMPLATE } from "./template.js";
import { definePlugin } from "@dianemo/core";

export const zeteoPlugin = definePlugin({
  name: ZETEO_TEMPLATE,
  registerTemplate: registerZeteoTemplate,
  createRequests: (ctx) => ({ handler: ctx.handler }),
});
