import { CARRIER_PROTOCOL, serviceMessageSchema, type CarrierMessage } from "@multiservers/carrier-protocol";
import { Carrier } from "./carrier.js";

/**
 * The carrier process. It is started by Multiservers service with a Node IPC
 * channel and ends when that channel closes; it opens no control port of its
 * own and reads no configuration beyond the messages it is sent.
 */
if (!process.send) {
  console.error("The carrier runs only under Multiservers service.");
  process.exit(2);
}
// A service that closes while the carrier starts leaves no channel; the carrier then simply ends.
const send = (message: CarrierMessage) => {
  if (!process.connected) return;
  process.send?.(message, undefined, {}, (error) => {
    if (error) process.exit(0);
  });
};
const carrier = new Carrier(send);

process.on("message", (raw) => {
  const parsed = serviceMessageSchema.safeParse(raw);
  if (!parsed.success) return;
  const message = parsed.data;
  switch (message.type) {
    case "target":
      void carrier.setTarget(message.target);
      break;
    case "remove":
      void carrier.removeTarget(message.id);
      break;
    case "ticket":
      carrier.addTicket(message.target, message.ticket, message.expiresAt);
      break;
    case "revoke-passes":
      carrier.revokePasses();
      break;
  }
});
process.on("disconnect", () => {
  void carrier.close().finally(() => process.exit(0));
});
send({ type: "ready", protocol: CARRIER_PROTOCOL });
