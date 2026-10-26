// Marker protocol parser. The bracket form is the wire format:
//   [STATE_CHECKPOINT] <state block>   end of a non-final chunk
//   [TASK_COMPLETE]                    final chunk
//   [NEEDS_TOOL tool="..." input="..."] / [NEEDS_CLARIFICATION] <question>   pause
// Legacy (@@@STATE@@@, ---FINAL---, [STATE], [FINAL]) and the XML alternate
// (<CARRYOVER>…</CARRYOVER>, <DONE/>, <NEEDS_TOOL …/>, <NEEDS_CLARIFICATION>…,
// <PROGRESS>…) are read too. Parsing is case- and whitespace-tolerant; a
// malformed marker is reported as an error instead of being guessed at.

import type { MarkerSet } from "./types.ts";

const FINAL_RE = /\[(?:TASK_COMPLETE|FINAL)\][\s\S]*$/i;
const STATE_RE = /\[(?:STATE_CHECKPOINT|STATE)\][\s\S]*$/i;
const LEGACY_RE = /(@@@(?:STATE|FINAL)@@@|---(?:STATE|FINAL)---)[\s\S]*$/i;
const PAUSE_RE = /\[NEEDS_TOOL\b[^\]]*\]|\[NEEDS_CLARIFICATION\][\s\S]*$/gi;
const XML_RE = /<carryover>[\s\S]*?<\/carryover>|<done\s*\/?>|<needs_tool\b[^>]*\/?>|<needs_clarification>[\s\S]*?<\/needs_clarification>|<progress>[\s\S]*?<\/progress>/gi;

// Where any marker starts; used to cut a state block before a following marker.
const ANY_MARKER = /\[(?:TASK_COMPLETE|FINAL|STATE_CHECKPOINT|STATE|NEEDS_TOOL|NEEDS_CLARIFICATION)\b|@@@(?:STATE|FINAL)@@@|---(?:STATE|FINAL)---|<\/?(?:carryover|done|needs_tool|needs_clarification|progress)\b/i;

/** Display-safe text: every marker and everything after a state/final marker removed. */
export function cleanMarkers(text: string): string {
  return text
    .replace(XML_RE, " ")
    .replace(/<carryover>[\s\S]*$/i, "")
    .replace(PAUSE_RE, "")
    .replace(FINAL_RE, "")
    .replace(STATE_RE, "")
    .replace(LEGACY_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function parseMarkers(text: string): { cleaned: string; markers: MarkerSet; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const markers: MarkerSet = { final: false, format: "none" };
  const setFormat = (f: MarkerSet["format"]) => {
    if (markers.format === "none") markers.format = f;
  };
  const after = (re: RegExp): string | undefined => {
    const m = re.exec(text);
    if (!m) return undefined;
    const rest = text.slice(m.index + m[0].length);
    const next = ANY_MARKER.exec(rest);
    return (next ? rest.slice(0, next.index) : rest).trim();
  };

  // XML alternate.
  const carry = /<carryover>([\s\S]*?)<\/carryover>/i.exec(text);
  if (carry) {
    markers.state = carry[1].trim();
    setFormat("xml");
  } else if (/<carryover>/i.test(text)) {
    errors.push("malformed marker: <CARRYOVER> is never closed");
  }
  if (/<done\s*\/?>/i.test(text)) {
    markers.final = true;
    setFormat("xml");
  }
  const xmlTool = /<needs_tool\s+tool="([^"]*)"\s+input="([^"]*)"\s*\/?>/i.exec(text);
  if (xmlTool) markers.needsTool = { tool: xmlTool[1], input: xmlTool[2] };
  else if (/<needs_tool\b/i.test(text)) errors.push("malformed marker: <NEEDS_TOOL> needs tool=\"…\" and input=\"…\"");
  const xmlAsk = /<needs_clarification>([\s\S]*?)<\/needs_clarification>/i.exec(text);
  if (xmlAsk) markers.needsClarification = xmlAsk[1].trim();
  else if (/<needs_clarification>/i.test(text)) errors.push("malformed marker: <NEEDS_CLARIFICATION> is never closed");
  const progress = /<progress>([\s\S]*?)<\/progress>/i.exec(text);
  if (progress) markers.progress = progress[1].trim();

  // Bracket wire format.
  const tool = /\[NEEDS_TOOL\s+tool="([^"]*)"\s+input="([^"]*)"\s*\]/i.exec(text);
  if (tool) {
    markers.needsTool = { tool: tool[1], input: tool[2] };
    setFormat("bracket");
  } else if (/\[NEEDS_TOOL\b/i.test(text) && !xmlTool) {
    errors.push("malformed marker: [NEEDS_TOOL] needs tool=\"…\" and input=\"…\" inside closed brackets");
  }
  const ask = after(/\[NEEDS_CLARIFICATION\]/i);
  if (ask !== undefined) {
    markers.needsClarification = ask;
    setFormat("bracket");
  }
  if (/\[(?:TASK_COMPLETE|FINAL)\]/i.test(text)) {
    markers.final = true;
    setFormat("bracket");
  }
  const state = after(/\[(?:STATE_CHECKPOINT|STATE)\]/i);
  if (state !== undefined && markers.state === undefined) {
    markers.state = state;
    setFormat("bracket");
  }

  // Legacy variants, accepted but never emitted.
  if (/@@@FINAL@@@|---FINAL---/i.test(text)) {
    markers.final = true;
    setFormat("legacy");
  }
  const legacyState = after(/@@@STATE@@@|---STATE---/i);
  if (legacyState !== undefined && markers.state === undefined) {
    markers.state = legacyState;
    setFormat("legacy");
  }

  if (markers.final && markers.state !== undefined) warnings.push("both a state and a final marker in one chunk; final wins");
  return { cleaned: cleanMarkers(text), markers, errors, warnings };
}
