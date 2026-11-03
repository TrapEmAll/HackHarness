import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function configured(): { manifest: string; data: string | undefined } {
	const manifest = process.env.HH_MANIFEST;
	if (!manifest) throw new Error("Set HH_MANIFEST to an authorized HackHarness JSON manifest");
	return { manifest: path.resolve(manifest), data: process.env.HH_DATA_DIR };
}

// Inside an OMP worker process.execPath is omp.exe, not Node; hh cli.js needs Node.
const runtime = (process.env.HH_NODE || "node").trim() || "node";

async function hh(args: string[], signal?: AbortSignal): Promise<string> {
	const config = configured();
	const complete = [runtime, path.join(root, "src/cli.js"), args[0], config.manifest, ...args.slice(1), ...(config.data ? ["--data", config.data] : [])];
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn(complete[0], complete.slice(1), { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "";
	child.stdout.on("data", chunk => { stdout += chunk; });
	child.stderr.on("data", chunk => { stderr += chunk; });
	const abort = () => child.kill("SIGTERM");
	signal?.addEventListener("abort", abort, { once: true });
	child.on("error", reject);
	child.on("close", code => {
		signal?.removeEventListener("abort", abort);
		if (code === 0) resolve(stdout.trim());
		else reject(new Error(stderr.trim() || `HackHarness exited with code ${code}`));
	});
	return await promise;
}

const content = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export default function hackHarness(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "hh_context", label: "HackHarness context",
		description: "Read the active authorized engagement, identities, target scope, and request budget.",
		parameters: z.object({}), approval: "read",
		async execute(_id, _params, signal) { return content(await hh(["context"], signal)); },
	});
	pi.registerTool({
		name: "hh_hypothesis_submit", label: "Submit hypothesis",
		description: "Persist a falsifiable security hypothesis with its negative control and bounded check.",
		parameters: z.object({ claim:z.string(), control:z.string(), proposed_check:z.string() }), approval: "exec",
		async execute(_id, params, signal) { return content(await hh(["hypothesis","--claim",params.claim,"--control",params.control,"--check",params.proposed_check], signal)); },
	});
	pi.registerTool({
		name: "hh_investigate_authorization", label: "Investigate authorization",
		description: "Compare one in-scope object using two controlled identities through policy, budgets, redaction, and evidence capture.",
		parameters: z.object({ hypothesis_id:z.string(), path:z.string(), owner_identity:z.string(), other_identity:z.string() }), approval: "exec",
		async execute(_id, params, signal) { return content(await hh(["investigate",params.hypothesis_id,"--path",params.path,"--owner",params.owner_identity,"--other",params.other_identity], signal)); },
	});
	pi.registerTool({
		name: "hh_findings", label: "List findings",
		description: "List persisted findings with title, state, impact, and timestamps for duplication checks.",
		parameters: z.object({}), approval: "read",
		async execute(_id, _params, signal) { return content(await hh(["findings"], signal)); },
	});
	pi.registerTool({
		name: "hh_replay", label: "Replay finding",
		description: "Independently replay a candidate finding with fresh owner and negative-control captures.",
		parameters: z.object({ finding_id:z.string() }), approval: "exec",
		async execute(_id, params, signal) { return content(await hh(["replay",params.finding_id], signal)); },
	});
	pi.registerTool({
		name: "hh_evidence_read", label: "Read redacted evidence",
		description: "Read a redacted immutable evidence artifact by ID.",
		parameters: z.object({ evidence_id:z.string() }), approval: "read",
		async execute(_id, params, signal) { return content(await hh(["evidence",params.evidence_id], signal)); },
	});
	pi.registerCommand("hh", {
		description: "HackHarness: /hh context | hypotheses | findings | pause | resume | review FINDING approve|reject | report FINDING",
		handler: async (raw, ctx) => {
			const parts=raw.trim().split(/\s+/).filter(Boolean), action=parts.shift() || "context";
			const allowed=new Set(["context","hypotheses","findings","pause","resume"]);
			const review=action === "review" && parts.length === 2 && new Set(["approve","reject"]).has(parts[1]);
			if (!allowed.has(action) && !(action === "report" && parts.length === 1) && !review) { ctx.ui.notify("Usage: /hh context | hypotheses | findings | pause | resume | review FINDING approve|reject | report FINDING", "warning"); return; }
			try {
				const commandArgs=review?["review",parts[0],"--decision",parts[1]]:[action,...parts];
				const output=await hh(commandArgs);
				pi.sendMessage({customType:"hackharness",content:output,display:true,attribution:"user"},{triggerTurn:false});
			} catch(error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
}
