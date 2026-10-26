import { issueContract, scanUntrusted, verifyContract, type ExecutionContract } from "@lotline/scout";
import type { TraceLog } from "@lotline/core";
import type { ActionGate } from "./context.ts";

/** The Scout engine as Lotline's action gate: nothing acts without a signed execution contract. */
export class ScoutGate implements ActionGate {
  private readonly issued = new Map<string, ExecutionContract>();

  constructor(private readonly secret: string, private readonly trace: TraceLog) {}

  issue(req: Parameters<ActionGate["issue"]>[0]): ReturnType<ActionGate["issue"]> {
    const out = issueContract(req, this.secret);
    if ("refused" in out) {
      this.trace.emit({
        agent_name: "ScoutGate", action: "contract.refused", input_summary: `${req.intent} ${req.target}`,
        output_summary: `${out.reason}: ${out.detail}`.slice(0, 200), target_agent: "ActionPlanner", status: "escalated",
        detail: { intent: req.intent, target: req.target, reason: out.reason, proven_evidence: req.provenEvidenceCount },
      });
      return out;
    }
    this.issued.set(out.id, out);
    this.trace.emit({
      agent_name: "ScoutGate", action: "contract.issued", input_summary: `${req.intent} ${req.target}`,
      output_summary: `${out.id} risk=${out.risk}${out.requiresApproval ? " approval required" : ""}`, target_agent: "ActionPlanner",
      status: "success", detail: { contract: out },
    });
    return { id: out.id, requiresApproval: out.requiresApproval, risk: out.risk };
  }

  verify(contractId: string): boolean {
    const c = this.issued.get(contractId);
    return !!c && verifyContract(c, this.secret);
  }

  contract(contractId: string): ExecutionContract | undefined {
    return this.issued.get(contractId);
  }

  scan(text: string) {
    return scanUntrusted(text);
  }
}
