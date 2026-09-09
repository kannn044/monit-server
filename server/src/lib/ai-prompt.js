// System prompts and question routing.
//
// Two ideas are doing the work here.
//
// The first is that the model is told *how this system defines things*. It has
// never seen monit, so it does not know that "offline" is a time-since-sample
// rule rather than a ping, that avail_kb is kilobytes, or that an NDB node
// group losing every node is the one condition that stops the cluster. Those
// facts are cheap to state and expensive to guess wrong.
//
// The second is that a question is routed before any context is assembled.
// Packing the whole fleet into every message was what pushed the conversation
// out of the context window; deciding first what the question is about means a
// question about one server carries one server.

import { fleetHeader, fleetLine, serverDetail, incidentLine } from './ai-analytics.js';

const DOMAIN = `## How this system defines things (do not guess these)
- health: offline = no sample for 3x the 10s interval; critical/warning = an open incident of that severity; online = recent sample, no open incident. "offline" means the agent stopped reporting, NOT that the machine is confirmed down.
- cpu.total is a percentage across all cores. load.1m must be read against load.cores: load/cores > 1.0 means the run queue is backing up. Comparing a raw load number between hosts with different core counts is meaningless.
- disk.used_pct in a per-mount list is that mount. The tightest mount is often /boot or /boot/efi, which are small by design and always near full — judge a machine by the whole-machine figure and by mounts that matter.
- avail_kb, free_kb, size_kb are KILOBYTES. mem_used_mb is megabytes.
- network counters are cumulative; rates shown to you are already differenced.
- an incident goes firing -> acknowledged -> resolved, and may be silenced or flapping. "flapping" means the rule crossed its threshold repeatedly, which is a badly tuned rule as often as it is a sick server.
- MySQL NDB Cluster: data is sharded across node groups and mirrored inside each group. Losing SOME nodes in a group is survivable; losing EVERY node in ANY ONE group stops the whole cluster. A group down to its last live node is one failure away from that. NDB holds data in memory, so data_memory near 100% means writes start failing even with every node up. Without a connected arbitrator a split brain cannot be resolved.
- p95 over 24h next to a current value tells you whether now is normal for this host. z is measured against the same hour of day over the past 7 days, so it already accounts for nightly batch windows; |z| > 3 is genuinely unusual.
- a disk-full projection is a straight-line fit over 7 days. It is a warning, not a promise, and it is worthless if something changed recently.`;

const PROTOCOL = `## How to answer an analysis question
1. State what the data shows, with the number and the server name.
2. Look for correlation before concluding: is one server sick, or did several move together? Did it start at a particular time?
3. Give the most likely cause as a hypothesis, and say what would confirm it.
4. Recommend a concrete next action — a command to run, a threshold to change, a service to restart — not "monitor the situation".
5. End with a one-line confidence statement and what you would need to be sure.

## Rules you must not break
- Every claim cites a number that is present in the context or came back from a tool. If it is not there, say it is not there.
- Missing data is never good news. "No sample" means unknown, never healthy.
- Do not invent server names, incident ids, thresholds, file paths or log lines.
- Do not restate the whole context. Answer the question that was asked.
- Reply in the language the user wrote in. Keep Thai natural; keep metric names, units and identifiers in their original form.
- Prefer a short answer. Use a markdown table when comparing several servers on the same fields.`;

/**
 * Two worked examples, carried in the system message rather than as extra
 * turns.
 *
 * Shape is easier to teach by demonstration than by instruction, especially at
 * this model size: the protocol above says "end with a concrete action", and
 * the example is what makes that actually happen. Kept as text rather than as
 * user/assistant turns so it cannot be mistaken for real history, and so it
 * survives any chat template.
 */
const FEWSHOT = `## Two examples of the expected shape

Q: มี server กี่เครื่องที่ offline
A: 2 เครื่อง — **cache-02** (ไม่ส่งข้อมูลมา 3 ชม.) และ **build-01** (14 นาที)

"offline" ในระบบนี้แปลว่า agent หยุดส่ง sample ไม่ได้แปลว่าเครื่องดับ — ถ้าจะยืนยันว่าเครื่องยังอยู่ ต้องดูจากทางอื่น

Q: db-01 มีปัญหาอะไร
A: **RAM ไต่ขึ้นแบบไม่ลง** — ตอนนี้ 91.3% (24h p95 92.0, แนวโน้ม 7 วัน +1.1%/วัน, z=+3.1 เทียบชั่วโมงเดียวกันของสัปดาห์ก่อน)

CPU 41% ปกติ, disk / 62% ไม่มีปัญหา, load 2.1/8 cores = 0.26 สบาย — แปลว่าไม่ใช่โหลดจากภายนอก แต่เป็น RAM ที่ไม่ถูกคืน

สมมติฐาน: memory leak ของโพรเซสใดโพรเซสหนึ่ง ถ้าเป็นโหลดจริง CPU กับ load average ต้องขึ้นตามกัน

ยืนยัน: รัน ps -eo rss,etimes,cmd --sort=-rss | head บน db-01 แล้วเทียบ rss กับ etimes — ถ้าโพรเซสที่กิน RAM สูงสุดอายุยาวและ rss โตตามอายุ ก็คือ leak

ความมั่นใจ: ปานกลาง — รูปแบบ 7 วันชัด แต่ยังไม่มีข้อมูลระดับโพรเซสให้ชี้ตัวได้`;

/**
 * Assemble the system message.
 *
 * `scope` decides how much of the fleet comes along: a question about one
 * server gets that server in full and the rest as one line each, which is both
 * cheaper and more accurate than the old "everything, always".
 */
export function buildSystemPrompt({ snap, scope, role, toolNames = [], mode = 'analysis' }) {
  const parts = [
    `You are the SRE assistant built into monit, a self-hosted server monitoring system. `
    + `You are talking to a ${role} of this installation. Everything below was queried from the live database moments ago.`,
    DOMAIN,
  ];

  parts.push(`## Fleet right now\n${fleetHeader(snap)}`);

  const focus = scope?.servers?.length
    ? snap.list.filter((s) => scope.servers.includes(s.id))
    : [];

  if (focus.length && focus.length <= 4) {
    parts.push(`## Focus servers (full detail)\n${focus.map(serverDetail).join('\n\n')}`);
    const rest = snap.list.filter((s) => !scope.servers.includes(s.id));
    if (rest.length) parts.push(`## Other servers (one line each)\n${rest.map(fleetLine).join('\n')}`);
  } else {
    parts.push(`## Servers\n${snap.list.map(fleetLine).join('\n') || '(none)'}`);
  }

  if (snap.incidents.length) {
    parts.push(`## Open incidents (${snap.incidents.length})\n`
      + snap.incidents.slice(0, 25).map((i) => `- ${incidentLine(i)}`).join('\n'));
  } else {
    parts.push('## Open incidents\nNone.');
  }

  // Reading key: the fleet lines are dense on purpose, and a small model reads
  // them far better when told what the shorthand means than when left to infer.
  parts.push(`## Reading the server lines
"cpu 82.1%(24h p95 88) +2.1/d" = now, the 95th percentile over 24h, and the 7-day trend per day.
"disk / 91% avail 8.2GB (machine 74%) FULL~6.4d" = the fullest real filesystem, space left, the whole machine, then the straight-line projection. Partitions under 4GB are left out — /boot is near full by design and says nothing about capacity.
"load 0.99/core" = load average divided by core count.
"ANOM ram z=3.4" = far outside this host's own normal for this hour of day.
"MISSING docker[redis]" = declared as expected but not running.`);

  if (toolNames.length && mode !== 'lookup') {
    parts.push(`## Tools\nResults from ${toolNames.join(', ')} may already appear in this conversation. `
      + `Treat a tool result as the freshest truth, above anything above it.`);
  }

  parts.push(PROTOCOL);
  if (mode !== 'lookup') parts.push(FEWSHOT);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * Intent keywords.
 *
 * Split into ASCII and Thai halves for one reason: \b in JavaScript is defined
 * against [A-Za-z0-9_], so \bเต็ม\b can never match — the characters on both
 * sides of a Thai word are not word characters, so there is no boundary there
 * to find. Written as one alternation with \b it silently matched nothing
 * Thai, and every Thai question fell through to the default intent. The ASCII
 * terms still want \b, because "report" should not fire on "reported".
 */
const RE = {
  report: [/\b(report|export)\b/i, /(รายงาน|ออกรายงาน|สรุปเป็นเอกสาร)/],
  topology: [/\b(topolog\w*|ndb|cluster|node ?group)\b/i, /(คลัสเตอร์|แผนผัง|ผังการเชื่อม|โทโพโลยี)/],
  capacity: [/\b(capacity|forecast|disk ?full|trend)\b/i, /(จะเต็ม|เต็มเมื่อ|พื้นที่เหลือ|คาดการณ์|แนวโน้ม|โตขึ้น|พยากรณ์)/],
  analyze: [/\b(why|analy\w+|root cause|anomal\w*|correlat\w*|compare|recommend|tune|risk)\b/i,
    /(ทำไม|วิเคราะห์|สาเหตุ|เกิดอะไร|ผิดปกติ|เปรียบเทียบ|สัมพันธ์|ควรทำ|แนะนำ|ปรับ|เสี่ยง|ตรวจสอบ)/],
  lookup: [/\b(how many|list|show|what is|which)\b/i, /(กี่|จำนวน|แสดง|รายชื่อ|มีอะไรบ้าง|ชื่อ)/],
};

const hits = (key, t) => RE[key].some((r) => r.test(t));
/**
 * Classify a question and pull out which servers it names.
 *
 * Keywords first, because they are free and right most of the time. The point
 * is not perfect classification — it is not spending the whole context window
 * on a question that turned out to be "how many servers are there".
 */
export function routeIntent(text, snap) {
  const t = String(text || '');
  const servers = [];
  for (const s of snap.list) {
    const name = s.name.toLowerCase();
    // Two characters is not a server reference, it is a coincidence.
    if (name.length >= 3 && t.toLowerCase().includes(name)) servers.push(s.id);
  }

  // Order matters: "ขอรายงาน ndb cluster" is a report about topology, not a
  // topology question, so report is tested first.
  let intent;
  if (hits('report', t)) intent = 'report';
  else if (hits('analyze', t)) intent = 'analyze';
  else if (hits('topology', t)) intent = 'topology';
  else if (hits('capacity', t)) intent = 'capacity';
  else if (hits('lookup', t)) intent = 'lookup';
  else intent = 'analyze';

  // A lookup that names one server is really a drill-down, and the extra
  // detail costs almost nothing once the server is already chosen.
  if (intent === 'lookup' && servers.length === 1) intent = 'analyze';

  return {
    intent,
    servers,
    // Only a lookup is confident enough to skip the tool phase: everything
    // else benefits from the model being able to go and look.
    useTools: intent !== 'lookup',
    profile: intent === 'lookup' ? 'lookup' : 'analysis',
  };
}

/** The instruction for the planning turn — deciding what to look up, not answering. */
export const PLAN_INSTRUCTION = `Decide what extra data you need to answer well, and call the tools to get it.
- Call a tool only when the answer is not already in the context above.
- You may call several tools in one turn.
- Do NOT write the answer yet. If you already have everything you need, reply with exactly: READY`;
