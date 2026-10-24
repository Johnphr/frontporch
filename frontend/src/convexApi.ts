// Untyped Convex API reference, so the app builds before a Convex deployment exists.
// After `npx convex dev` has generated convex/_generated, you can switch to the typed API:
//   export { api } from "../convex/_generated/api";
import { anyApi } from "convex/server";

export const api = anyApi;
