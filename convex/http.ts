import { httpRouter } from "convex/server";
import { servePostsPage } from "./postsPage";

// Served at https://<deployment>.convex.site. Cartesia transcripts are polled (cartesia.pollCall)
// until Cartesia ships call webhooks. This file must keep a default-exported router.
const http = httpRouter();

// TEMPORARY: posts review page (convex/postsPage.ts). Remove with that file.
http.route({ path: "/posts", method: "GET", handler: servePostsPage });

export default http;
