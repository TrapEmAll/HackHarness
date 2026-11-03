#!/usr/bin/env node
// Minimal OMP RPC wire fake for HackHarness contract tests.
// HH_FAKE_MODE: ok (normal run) | stuck (never finishes until aborted)
const mode = process.env.HH_FAKE_MODE || "ok"; // ok | stuck | dud
const out = (frame) => { try { process.stdout.write(JSON.stringify(frame) + "\n"); } catch {} };
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
let streaming = null;
setInterval(() => { // drip text for the active prompt so hosts see mid-run events
  if (streaming) out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "chunk " } });
}, 50).unref();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    let frame; try { frame = JSON.parse(line); } catch { continue; }
    if (frame.type === "prompt") {
      const id = frame.id;
      out({ id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
      if (mode === "ok") {
        out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "worker said hi " } });
        out({ type: "agent_end", messages: [], isTerminal: true });
        out({ id, type: "prompt_result", agentInvoked: true });
      } else if (mode === "dud") {
        out({ type: "agent_end", messages: [], isTerminal: true });
        out({ id, type: "prompt_result", agentInvoked: true });
      } else { streaming = id; } // stuck: waits for abort
    } else if (frame.type === "abort") {
      streaming = null;
      out({ id: frame.id, type: "response", command: "abort", success: true });
      out({ type: "agent_end", messages: [], isTerminal: true });
    } else if (frame.type === "get_session_stats") {
      out({ id: frame.id, type: "response", command: "get_session_stats", success: true, data: { cost: 0.01, tokens: { total: 42 } } });
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
