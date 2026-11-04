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

// Role gating: workers get only the tools their role needs. HH_ROLE maps to an
// allowlist; anything outside it never registers, so prompt injection cannot
// call target-facing tools from a read-only role. Default "all" for CLI use.
const role = process.env.HH_ROLE || "all";
const roleTools: Record<string, string[] | null> = {
	all: null,
	reviewer: ["hh_context", "hh_findings", "hh_evidence_read", "hh_source_read"],
	mapper: ["hh_context", "hh_source_read", "hh_map_query", "hh_hypothesis_submit"],
};
const roleAllow = roleTools[role] ?? roleTools.all;

export default function hackHarness(pi: ExtensionAPI): void {
	const z = pi.zod;
	const tools: Record<string, Omit<Parameters<typeof pi.registerTool>[0], "name"> & { name: string }> = {
		hh_context: {
			label: "HackHarness context",
			description: "Read the active authorized engagement, identities, target scope, and request budget.",
			parameters: z.object({}), approval: "read" as const,
			async execute(_id: string, _params: object, signal?: AbortSignal) { return content(await hh(["context"], signal)); },
		},
		hh_hypothesis_submit: {
			label: "Submit hypothesis",
			description: "Persist a falsifiable security hypothesis with its negative control and bounded check.",
			parameters: z.object({ claim:z.string(), control:z.string(), proposed_check:z.string() }), approval: "exec" as const,
			async execute(_id: string, params: { claim: string; control: string; proposed_check: string }, signal?: AbortSignal) { return content(await hh(["hypothesis","--claim",params.claim,"--control",params.control,"--check",params.proposed_check], signal)); },
		},
		hh_investigate_authorization: {
			label: "Investigate authorization",
			description: "Compare one in-scope object using two controlled identities through policy, budgets, redaction, and evidence capture.",
			parameters: z.object({ hypothesis_id:z.string(), path:z.string(), owner_identity:z.string(), other_identity:z.string() }), approval: "exec" as const,
			async execute(_id: string, params: { hypothesis_id: string; path: string; owner_identity: string; other_identity: string }, signal?: AbortSignal) { return content(await hh(["investigate",params.hypothesis_id,"--path",params.path,"--owner",params.owner_identity,"--other",params.other_identity], signal)); },
		},
		hh_findings: {
			label: "List findings",
			description: "List persisted findings with title, state, impact, and timestamps for duplication checks.",
			parameters: z.object({}), approval: "read" as const,
			async execute(_id: string, _params: object, signal?: AbortSignal) { return content(await hh(["findings"], signal)); },
		},
		hh_map_query: {
			label: "Query application map",
			description: "Read recorded application-map observations (endpoint probes, authorization diffs) with their evidence references.",
			parameters: z.object({}), approval: "read" as const,
			async execute(_id: string, _params: object, signal?: AbortSignal) { return content(await hh(["observations"], signal)); },
		},
		hh_request: {
			label: "Scoped single request",
			description: "Issue one in-scope HTTP request as a declared identity through the policy, budgets, redaction, and evidence capture. Creates its own short-lived lease; concurrent duplicates are refused.",
			parameters: z.object({ identity_id:z.string(), path:z.string(), method:z.string().optional(), purpose:z.string().optional() }), approval: "exec" as const,
			async execute(_id: string, params: { identity_id: string; path: string; method?: string; purpose?: string }, signal?: AbortSignal) {
				const args = ["request","--identity",params.identity_id,"--path",params.path,"--purpose",params.purpose || "manual scoped request"];
				if (params.method) args.push("--method", params.method);
				return content(await hh(args, signal));
			},
		},
		hh_replay: {
			label: "Replay finding",
			description: "Independently replay a candidate finding with fresh owner and negative-control captures.",
			parameters: z.object({ finding_id:z.string() }), approval: "exec" as const,
			async execute(_id: string, params: { finding_id: string }, signal?: AbortSignal) { return content(await hh(["replay",params.finding_id], signal)); },
		},
		hh_evidence_read: {
			label: "Read redacted evidence",
			description: "Read a redacted immutable evidence artifact by ID.",
			parameters: z.object({ evidence_id:z.string() }), approval: "read" as const,
			async execute(_id: string, params: { evidence_id: string }, signal?: AbortSignal) { return content(await hh(["evidence",params.evidence_id], signal)); },
		},
		hh_source_read: {
			label: "Read declared source",
			description: "Read a file from a manifest-declared read-only target source root (traversal-guarded, identity-redacted, evidence-backed).",
			parameters: z.object({ source_id:z.string(), file:z.string() }), approval: "read" as const,
			async execute(_id: string, params: { source_id: string; file: string }, signal?: AbortSignal) { return content(await hh(["source-read","--source",params.source_id,"--file",params.file], signal)); },
		},
	};
	for (const [name, definition] of Object.entries(tools)) {
		if (roleAllow && !roleAllow.includes(name)) continue;
		pi.registerTool({ name, ...definition });
	}
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
