import { discoveryResponse } from "../../src/webapp/mcp-server.mjs";

export const onRequestGet = ({ request }) => discoveryResponse(request, "catalog");
