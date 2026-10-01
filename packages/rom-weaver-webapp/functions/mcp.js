import { handleMcpRequest } from "../src/webapp/mcp-server.mjs";

export const onRequest = ({ request }) => handleMcpRequest(request);
