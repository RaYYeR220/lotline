/**
 * Lotline's intent registry: the recall actions an operator (or an agent) may ask Scout for.
 * Free-text commands such as "hold store 9's romaine until the trace is proven" are classified
 * against this; structured callers use issueContract() in policy.ts directly.
 */
import type { RegistryDocument } from "./types.ts";

const ROLES = ["coordinator", "qa", "operator", "agent"];
const SURFACES = ["chat", "api", "agent"];
const target = {
  type: "object",
  properties: {
    location: { type: "string" },
    lot: { type: "string" },
    when: { type: "string" },
  },
};

export const LOTLINE_INTENTS: RegistryDocument = {
  version: 1,
  intents: [
    {
      id: "GENERAL",
      category: "general",
      description: "Safe fallback: answer conversationally, never route to tools.",
      parameters: { type: "object", properties: {} },
      capabilities: [],
      riskClass: "low",
      surfaces: ["*"],
      roles: ["*"],
      examples: ["hello", "what can you help me with?", "how does the trace work?"],
      version: 1,
    },
    {
      id: "recall.pull",
      category: "recall",
      description: "Pull proven affected product off shelves and out of inventory at a location. Requires human approval.",
      parameters: target,
      capabilities: ["world.query", "world.assert", "approval.require"],
      riskClass: "high",
      surfaces: SURFACES,
      roles: ROLES,
      examples: [
        "Pull lot 4471 from store 14",
        "Remove the affected romaine from every shelf at the Eastside store",
        "Pull all cases of lot L-2207 at the downtown distribution center",
        "Take the implicated bagged salad off sale at store 3",
      ],
      version: 1,
    },
    {
      id: "recall.hold",
      category: "recall",
      description: "Place possibly affected stock on hold while the trace is unproven.",
      parameters: target,
      capabilities: ["world.query", "world.assert"],
      riskClass: "medium",
      surfaces: SURFACES,
      roles: ROLES,
      examples: [
        "Put store 9's inventory of lot 4471 on hold",
        "Hold the spinach shipment at the cross-dock until the trace is proven",
        "Quarantine pallets from lot 88 pending review",
        "Freeze sales of the suspect cucumbers at the north warehouse",
      ],
      version: 1,
    },
    {
      id: "recall.clear",
      category: "recall",
      description: "Clear a location that records prove received only unaffected lots. Needs proven negative evidence.",
      parameters: target,
      capabilities: ["world.query", "world.assert"],
      riskClass: "medium",
      surfaces: SURFACES,
      roles: ROLES,
      examples: [
        "Clear store 3, it only received unaffected lots",
        "Release the hold at store 22, records show no implicated lots",
        "Mark the north distribution center as unaffected",
      ],
      version: 1,
    },
    {
      id: "recall.escalate",
      category: "recall",
      description: "Escalate a conflict or ambiguous trace link to a human reviewer.",
      parameters: target,
      capabilities: ["world.query", "email.draft"],
      riskClass: "low",
      surfaces: SURFACES,
      roles: ROLES,
      examples: [
        "Escalate the conflicting receiving records at store 5 to a human",
        "Send the store 12 quantity mismatch to QA for review",
        "Flag the ambiguous transfer for the recall coordinator",
      ],
      version: 1,
    },
    {
      id: "recall.notify",
      category: "recall",
      description: "Notify affected locations, customers or regulators about the recall. Requires human approval.",
      parameters: { type: "object", properties: { audience: { type: "string" }, when: { type: "string" } } },
      capabilities: ["world.query", "email.draft", "email.send", "approval.require"],
      riskClass: "high",
      surfaces: SURFACES,
      roles: ROLES,
      examples: [
        "Notify store 14's manager about the recall",
        "Email every affected location the FDA notice",
        "Send recall notices to the downstream retailers",
      ],
      version: 1,
    },
  ],
};
