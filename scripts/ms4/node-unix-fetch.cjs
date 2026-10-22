"use strict";

// Pi's OpenAI-compatible provider defaults to globalThis.fetch. Replace it
// before the agent bundle loads so API traffic uses the selected Unix socket.
// The accompanying seccomp wrapper denies all non-Unix socket creation for Pi
// and every tool subprocess, so this transport is the only network path.
const { Agent, fetch: undiciFetch } = require("/workspace/pi/node_modules/undici");
const net = require("node:net");

const socketPath = process.env.KILN_VLLM_SOCKET;
if (!socketPath) {
  throw new Error("KILN_VLLM_SOCKET is required");
}

const allowedOrigin = "http://127.0.0.1:8000";
const dispatcher = new Agent({ connect: { socketPath } });
const originalConnect = net.connect;

function rewriteConnectArguments(args) {
  const [first, second, third] = args;
  if (first && typeof first === "object") {
    const host = first.hostname ?? first.host ?? "localhost";
    if ((host === "127.0.0.1" || host === "localhost") && Number(first.port) === 8000) {
      const options = { ...first, path: socketPath };
      delete options.host;
      delete options.hostname;
      delete options.port;
      return [options, second].filter((value) => value !== undefined);
    }
  }
  if (Number(first) === 8000 && (typeof second !== "string" || second === "127.0.0.1" || second === "localhost")) {
    const callback = typeof second === "function" ? second : third;
    return [{ path: socketPath }, callback].filter((value) => value !== undefined);
  }
  return args;
}

function kilnUnixConnect(...args) {
  return originalConnect.apply(net, rewriteConnectArguments(args));
}

// The bundled OpenAI client can use a private fetch shim rather than
// globalThis.fetch. Redirect its underlying localhost TCP dial as well.
net.connect = kilnUnixConnect;
net.createConnection = kilnUnixConnect;

globalThis.fetch = function kilnUnixFetch(input, init = {}) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== allowedOrigin) {
    return Promise.reject(new TypeError(`network origin blocked by MS4 policy: ${url.origin}`));
  }
  return undiciFetch(input, { ...init, dispatcher });
};
