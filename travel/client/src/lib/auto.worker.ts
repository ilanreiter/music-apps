import { autoOrder } from "./arrange";

self.onmessage = (e: MessageEvent) => {
  const { dests, s, pairings, start, disabled } = e.data;
  const r = autoOrder(dests, s, pairings, start, disabled);
  (self as unknown as Worker).postMessage(r);
};
