import { z } from "zod";

/**
 * The control protocol between Multiservers service and its carrier: the
 * standalone process that turns a loopback web service on a machine into a
 * page with its own origin. Messages name targets and generic entry
 * credentials only; the carrier never learns which application it carries.
 */

export const CARRIER_PROTOCOL = 1;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const portSchema = z.number().int().min(1).max(65535);

/** How the carrier enters the upstream itself. A closed set: adding one is a deliberate carrier change. */
export const entryCredentialSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  /** Requests `path?parameter=token` once and keeps the cookies the upstream sets. */
  z.strictObject({
    kind: z.literal("query-token"),
    path: z.string().startsWith("/").max(500),
    parameter: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    token: z.string().min(1).max(1000),
  }),
  /** Adds one fixed request header to every upstream request. */
  z.strictObject({
    kind: z.literal("header"),
    name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    value: z.string().max(4000),
  }),
]);
export type EntryCredential = z.infer<typeof entryCredentialSchema>;

export const carrierTargetSchema = z.strictObject({
  id: idSchema,
  /** Where browsers reach this target's page. */
  bind: z.string().min(1).max(100),
  port: portSchema,
  /** A private Unix socket the service relays to the upstream through. */
  upstream: z.string().min(1).max(400),
  /** The Host (and Origin) presented upstream, such as `127.0.0.1:3080`. */
  authority: z.string().regex(/^[A-Za-z0-9.\-[\]:]{1,300}$/),
  credential: entryCredentialSchema,
  /** Changes whenever the upstream run changes; the carrier then enters again with an empty jar. */
  generation: z.string().min(1).max(200),
});
export type CarrierTarget = z.infer<typeof carrierTargetSchema>;

export const serviceMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("target"), target: carrierTargetSchema }),
  z.strictObject({ type: z.literal("remove"), id: idSchema }),
  z.strictObject({
    type: z.literal("ticket"),
    target: idSchema,
    ticket: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    /** Milliseconds since the epoch. */
    expiresAt: z.number().int().positive(),
  }),
  /** Ends every browser pass, for example after a browser's access was removed. */
  z.strictObject({ type: z.literal("revoke-passes") }),
]);
export type ServiceMessage = z.infer<typeof serviceMessageSchema>;

export const carrierMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), protocol: z.literal(CARRIER_PROTOCOL) }),
  z.strictObject({ type: z.literal("listening"), id: idSchema, port: portSchema }),
  z.strictObject({ type: z.literal("failed"), id: idSchema, reason: z.string().max(500) }),
  z.strictObject({ type: z.literal("upstream"), id: idSchema, reachable: z.boolean() }),
]);
export type CarrierMessage = z.infer<typeof carrierMessageSchema>;

/** The carrier path that exchanges a ticket for this browser's pass to one target. */
export const CARRIER_ENTRY_PATH = "/__multiservers/enter";
