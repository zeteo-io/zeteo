import { startStub, testHandler, type Stub } from "./stub.js";
import type { CallContext } from "../../send.js";
import type RequestHandler from "@dianemo/core";
import { afterEach, beforeEach } from "vitest";
import {
  createZeteoClient,
  transportOf,
  type ZeteoClient,
} from "../../client.js";

export interface StubbedClient {
  stub: Stub;
  client: ZeteoClient;
  ctx(token?: string): CallContext;
}

// Registers hooks: a started client against a fresh stub for every test.
export function useStubbedClient(): StubbedClient {
  let handler: RequestHandler;
  const state = {} as StubbedClient;

  beforeEach(async () => {
    state.stub = await startStub();
    handler = testHandler();
    state.client = createZeteoClient({
      handler,
      url: state.stub.url,
      tereoUrl: state.stub.url,
      clientId: "svc",
      clientSecret: "client-secret-1",
    });
    await state.client.start();
  });

  afterEach(async () => {
    await handler.stop();
    await state.stub.close();
  });

  state.ctx = (token) => ({ transport: transportOf(state.client), token });
  return state;
}
