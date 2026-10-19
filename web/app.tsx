import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  MarkerType,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeProps,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { computeFold } from "../src/fold.js";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type Shape = "rectangle" | "rounded" | "pill" | "diamond" | "ellipse";

interface Provenance {
  source_range: string;
  quote: string;
}
interface N2fNode {
  id: string;
  label: string;
  kind: string;
  details?: string[];
  provenance?: Provenance[];
  provenance_status?: string;
  style?: { shape?: Shape; color?: string };
}
interface N2fEdge {
  from: string;
  to: string;
  relation: string;
  grounding?: string;
  status?: string;
  quote?: string;
  source_range?: string;
  label?: string | null;
}
interface Issue {
  kind: string;
  severity: "info" | "warn";
  message: string;
  targets: string[];
}
interface N2fGraph {
  graph_id: string;
  map_type: string;
  nodes: N2fNode[];
  edges: N2fEdge[];
  meta?: Record<string, unknown>;
  issues?: Issue[];
}

type NodeData = {
  label: string;
  kind: string;
  details?: string[];
  shape?: Shape;
  color?: string;
  userAdded: boolean;
  unverified: boolean;
  provenance: Provenance[] | null;
  highlighted?: boolean;
  /** View-only fold state, derived at render time (never saved). */
  detailsOpen?: boolean;
  hasChildren?: boolean;
  branchFolded?: boolean;
  hiddenCount?: number;
};
type AppNode = RFNode<NodeData, "n2f">;

type EdgeData = {
  relation: string;
  grounding: string;
  status?: string;
  quote?: string;
  source_range?: string;
  label: string | null;
};
type AppEdge = RFEdge<EdgeData>;

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

type MapType = "plan" | "process";
const MAP_TYPE_LABELS: Record<MapType, string> = { plan: "Idea map", process: "Process map" };
const KINDS_BY_MAP_TYPE: Record<MapType, string[]> = {
  plan: ["claim", "assumption", "option", "decision", "action", "prereq", "question", "note"],
  process: ["start", "step", "decision", "outcome", "note"],
};
const RELATIONS = ["causes", "requires", "supports", "contradicts", "part_of", "next"];
const asMapType = (v: unknown): MapType => (v === "process" ? "process" : "plan");
const SHAPES: { id: Shape; label: string; glyph: string }[] = [
  { id: "rectangle", label: "Rectangle", glyph: "▭" },
  { id: "rounded", label: "Rounded", glyph: "▢" },
  { id: "pill", label: "Pill", glyph: "⬭" },
  { id: "diamond", label: "Diamond", glyph: "◇" },
  { id: "ellipse", label: "Ellipse", glyph: "◯" },
];
const SWATCHES = [
  "#e8f0fe", "#f3e8fd", "#e6f4ea", "#fef7e0", "#fce8e6", "#e0f2f1",
  "#bfdbfe", "#fde68a", "#fecaca", "#bbf7d0", "#2563eb", "#dc2626",
  "#059669", "#7c3aed", "#f59e0b", "#111827",
];

const REL_ARROW: Record<string, string> = {
  causes: "→",
  requires: "⇢",
  supports: "⇉",
  contradicts: "⇏",
  part_of: "⊂",
  next: "→",
};

// Mirrors src/schema.ts defaultShape (kept local so the browser bundle does not pull in zod).
function defaultShape(kind: string): Shape {
  if (kind === "start" || kind === "outcome") return "pill";
  return kind === "decision" || kind === "question" ? "diamond" : "rounded";
}

interface ThemeDef {
  label: string;
  dark: boolean;
  edge: string;
  accent: string;
  ink: string;
  labelBg: string;
  grid: string;
}
const THEMES: Record<string, ThemeDef> = {
  clean: { label: "Clean", dark: false, edge: "#64748b", accent: "#2563eb", ink: "#1f2937", labelBg: "#ffffff", grid: "#e2e8f0" },
  sketch: { label: "Sketch (hand-drawn)", dark: false, edge: "#1e1e1e", accent: "#4a6fa5", ink: "#1e1e1e", labelBg: "#faf9f6", grid: "#e7e3da" },
  dark: { label: "Dark", dark: true, edge: "#94a3b8", accent: "#60a5fa", ink: "#e2e8f0", labelBg: "#1e293b", grid: "#334155" },
};
// "auto" = whatever the theme defines (see app.css).
const FONTS: Record<string, { label: string; stack: string | null }> = {
  auto: { label: "Theme default", stack: null },
  sans: { label: "Sans-serif", stack: `system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` },
  serif: { label: "Serif", stack: `Georgia, "Times New Roman", serif` },
  mono: { label: "Monospace", stack: `ui-monospace, "Cascadia Code", Consolas, monospace` },
  handwritten: { label: "Handwritten", stack: `"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive` },
};

const USER_PROVENANCE: Provenance = { source_range: "user-added", quote: "(added by user)" };

const STARTER_NOTES = `# Problem

Notes2Flow should turn these notes into a map.

# Options

1. React Flow canvas with a hand-drawn look.
2. Excalidraw embedded.

# Decision

We propose React Flow because nodes and edges map one-to-one to the data model.
This requires elkjs for layout. The 2024 precedent supports canvas editors.
`;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function contrastText(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  if (Number.isNaN(n)) return "#1f2937";
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.55 ? "#1f2937" : "#ffffff";
}

function readPref(key: string, allowed: string[], fallback: string): string {
  try {
    const v = window.localStorage.getItem(key);
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function fromGraph(g: N2fGraph): { nodes: AppNode[]; edges: AppEdge[] } {
  const ids = new Set(g.nodes.map((n) => n.id));
  const nodes: AppNode[] = g.nodes.map((n) => ({
    id: n.id,
    type: "n2f",
    position: { x: 0, y: 0 },
    data: {
      label: n.label,
      kind: n.kind,
      details: n.details,
      shape: n.style?.shape,
      color: n.style?.color,
      userAdded: n.provenance_status === "user_added",
      unverified: n.provenance_status === "unverified",
      provenance: n.provenance ?? null,
    },
  }));
  const edges: AppEdge[] = g.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e, i) => ({
      id: `e_${i}`,
      source: e.from,
      target: e.to,
      data: {
        relation: e.relation,
        grounding: e.grounding ?? "explicit",
        status: e.status,
        quote: e.quote,
        source_range: e.source_range,
        label: e.label ?? null,
      },
    }));
  return { nodes, edges };
}

/** Build the canonical graph (what exports / review consume) from the canvas state. */
function toGraph(nodes: AppNode[], edges: AppEdge[], base: N2fGraph | null, mapType: MapType) {
  return {
    graph_id: base?.graph_id ?? "user-map",
    map_type: mapType,
    meta: base?.meta,
    nodes: nodes.map((n) => {
      const style: { shape?: Shape; color?: string } = {};
      if (n.data.shape) style.shape = n.data.shape;
      if (n.data.color) style.color = n.data.color;
      return {
        id: n.id,
        label: n.data.label.trim() || "(untitled)",
        kind: n.data.kind,
        ...(n.data.details?.some((d) => d.trim()) ? { details: n.data.details.map((d) => d.trim()).filter(Boolean) } : {}),
        provenance: n.data.provenance ?? [USER_PROVENANCE],
        provenance_status: n.data.userAdded ? "user_added" : n.data.unverified ? "unverified" : "verified",
        ...(Object.keys(style).length > 0 ? { style } : {}),
      };
    }),
    edges: edges.map((e) => ({
      from: e.source,
      to: e.target,
      relation: e.data?.relation ?? "supports",
      grounding: e.data?.grounding ?? "explicit",
      label: e.data?.label ?? null,
      quote: e.data?.quote ?? USER_PROVENANCE.quote,
      source_range: e.data?.source_range ?? USER_PROVENANCE.source_range,
      status: e.data?.status ?? "user_confirmed",
    })),
  };
}

async function fetchPositions(
  nodes: { id: string; kind: string; label: string; details?: string[] }[],
  pairs: { from: string; to: string }[],
  mapType: MapType,
): Promise<Map<string, { x: number; y: number }>> {
  const ids = nodes.map((n) => n.id);
  const positions = new Map<string, { x: number; y: number }>();
  try {
    const res = await fetch("/api/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes, edges: pairs, map_type: mapType }),
    });
    const data = await res.json();
    for (const [id, pos] of Object.entries(data.positions ?? {})) {
      positions.set(id, pos as { x: number; y: number });
    }
  } catch {
    // ignore; grid fallback below
  }
  ids.forEach((id, i) => {
    if (!positions.has(id)) positions.set(id, { x: (i % 4) * 260, y: Math.floor(i / 4) * 130 });
  });
  return positions;
}

/* ------------------------------------------------------------------ */
/* Canvas pieces                                                       */
/* ------------------------------------------------------------------ */

interface FoldApi {
  toggleDetails: (id: string) => void;
  toggleBranch: (id: string) => void;
}
const FoldContext = React.createContext<FoldApi>({ toggleDetails: () => {}, toggleBranch: () => {} });

function N2fNodeView({ id, data, selected }: NodeProps<AppNode>) {
  const fold = React.useContext(FoldContext);
  const detailCount = data.details?.length ?? 0;
  const hasDetails = detailCount > 0;
  const open = hasDetails && !!data.detailsOpen;
  const chosen = data.shape ?? defaultShape(data.kind);
  // A diamond cannot hold a criteria list, so an expanded node draws as a box; the kind class still marks decisions.
  const shape = chosen === "diamond" && open ? "rounded" : chosen;
  const cls = [
    "n2f-node",
    `shape-${shape}`,
    `kind-${data.kind}`,
    open ? "has-details" : "",
    selected ? "is-selected" : "",
    data.highlighted ? "is-highlight" : "",
    data.unverified ? "is-unverified" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const style = {
    "--node-bg": data.color ?? `var(--kind-${data.kind}, #fff)`,
    color: data.color ? contrastText(data.color) : "var(--node-ink)",
  } as CSSProperties;
  return (
    <div className={cls} style={style}>
      {shape === "diamond" && (
        <svg className="n2f-diamond" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points="50,1 99,50 50,99 1,50" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <Handle type="target" position={Position.Top} className="n2f-handle" />
      <div className="n2f-label">{data.label}</div>
      {hasDetails && (
        <button
          className="n2f-details-toggle nodrag"
          title={open ? "Hide the list" : "Show the list"}
          onClick={(e) => {
            e.stopPropagation();
            fold.toggleDetails(id);
          }}
        >
          {open ? "▾" : "▸"} {detailCount} {detailCount === 1 ? "item" : "items"}
        </button>
      )}
      {open && (
        <ul className="n2f-details">
          {data.details!.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
      <span className="badge">
        {data.kind}
        {data.unverified ? " · unverified" : ""}
        {data.userAdded ? " · yours" : ""}
      </span>
      <Handle type="source" position={Position.Bottom} className="n2f-handle" />
      {data.hasChildren && (
        <button
          className={`n2f-fold nodrag ${data.branchFolded ? "is-folded" : ""}`}
          title={data.branchFolded ? `Show ${data.hiddenCount ?? 0} hidden nodes` : "Hide everything after this node"}
          onClick={(e) => {
            e.stopPropagation();
            fold.toggleBranch(id);
          }}
        >
          {data.branchFolded ? `+${data.hiddenCount ?? 0}` : "−"}
        </button>
      )}
    </div>
  );
}
const nodeTypes = { n2f: N2fNodeView };

/** Re-fits the viewport whenever `version` changes (after extract / re-layout). */
function FitController({ version }: { version: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (version === 0) return;
    const t = window.setTimeout(() => void fitView({ padding: 0.15, duration: 300 }), 80);
    return () => window.clearTimeout(t);
  }, [version, fitView]);
  return null;
}

function EditorToolbar(props: {
  kinds: string[];
  kind: string;
  setKind: (k: string) => void;
  relation: string;
  setRelation: (r: string) => void;
  onAdd: (kind: string, position: { x: number; y: number }) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const add = () => {
    const el = document.querySelector(".react-flow") as HTMLElement | null;
    const r = el?.getBoundingClientRect();
    const jitter = (Math.random() - 0.5) * 80;
    const pos = screenToFlowPosition({
      x: (r ? r.left + r.width / 2 : 600) + jitter - 110,
      y: (r ? r.top + r.height / 2 : 400) + jitter - 38,
    });
    props.onAdd(props.kind, pos);
  };
  return (
    <Panel position="top-left" className="editor-toolbar">
      <button className="btn small primary" onClick={add} title="Add a new node to the canvas">
        + Add node
      </button>
      <select value={props.kind} onChange={(e) => props.setKind(e.target.value)} title="Kind of the new node">
        {props.kinds.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <span className="toolbar-sep" />
      <label className="toolbar-label" title="Relation used when you drag a new arrow between nodes">
        New arrow:
        <select value={props.relation} onChange={(e) => props.setRelation(e.target.value)}>
          {RELATIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function App() {
  const [notes, setNotes] = useState<string>(STARTER_NOTES);
  const [model, setModel] = useState("z-ai/glm-5.3-flash");
  const [granularity, setGranularity] = useState("medium");
  const [mapType, setMapType] = useState<MapType>("plan");
  const [job, setJob] = useState<{ status: string; progress: string[]; error?: string } | null>(null);
  const [graph, setGraph] = useState<N2fGraph | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [highlightTargets, setHighlightTargets] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [fitVersion, setFitVersion] = useState(0);
  const [newKind, setNewKind] = useState("note");
  const [newRelation, setNewRelation] = useState("supports");
  const kinds = KINDS_BY_MAP_TYPE[mapType];
  // View-only fold state: nodes whose detail list is open, and nodes whose downstream branch is folded.
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set());
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const skipFoldRelayout = useRef(false);
  const [theme, setTheme] = useState(() => readPref("n2f.theme", Object.keys(THEMES), "clean"));
  const [font, setFont] = useState(() => readPref("n2f.font", Object.keys(FONTS), "auto"));

  const pollRef = useRef<number | null>(null);
  const dirty = useRef(false); // true once the user has edited the map by hand
  const nextUid = useRef(1);
  const pendingFocus = useRef(false);
  const labelRef = useRef<HTMLTextAreaElement | null>(null);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<AppNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<AppEdge>([]);

  const t = THEMES[theme] ?? THEMES.clean!;

  /* ---- theme / font ---- */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("n2f.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  useEffect(() => {
    const stack = FONTS[font]?.stack;
    if (stack) document.documentElement.style.setProperty("--font", stack);
    else document.documentElement.style.removeProperty("--font");
    try {
      window.localStorage.setItem("n2f.font", font);
    } catch {
      /* ignore */
    }
  }, [font]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }, []);

  /* ---- extraction ---- */
  const loadGraph = useCallback(
    async (g: N2fGraph) => {
      const { nodes, edges } = fromGraph(g);
      const mt = asMapType(g.map_type);
      setMapType(mt);
      setNewKind(mt === "process" ? "step" : "note");
      setNewRelation(mt === "process" ? "next" : "supports");
      if (openDetails.size > 0 || folded.size > 0) skipFoldRelayout.current = true;
      setOpenDetails((s) => (s.size > 0 ? new Set() : s));
      setFolded((s) => (s.size > 0 ? new Set() : s));
      // Details start collapsed, so the first layout uses the compact node sizes.
      const positions = await fetchPositions(
        nodes.map((n) => ({ id: n.id, kind: n.data.kind, label: n.data.label })),
        edges.map((e) => ({ from: e.source, to: e.target })),
        mt,
      );
      setRfNodes(nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position })));
      setRfEdges(edges);
      dirty.current = false;
      setFitVersion((v) => v + 1);
    },
    [setRfNodes, setRfEdges, openDetails, folded],
  );

  const poll = useCallback(
    (id: string) => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const res = await fetch(`/api/job/${id}`);
          const data = await res.json();
          setJob(data);
          if (data.status === "done" || data.status === "error") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            if (data.status === "done") {
              const g = data.graph as N2fGraph;
              setGraph(g);
              setIssues(g.issues ?? []);
              setHighlightTargets(new Set());
              await loadGraph(g);
              showToast(`Map ready: ${g.nodes.length} nodes, ${g.edges.length} edges`);
            } else {
              showToast(`Extraction failed: ${data.error}`);
            }
          }
        } catch (err) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          showToast(`Lost connection to the server: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, 1200);
    },
    [loadGraph, showToast],
  );

  useEffect(() => () => void (pollRef.current && window.clearInterval(pollRef.current)), []);

  const busy = job !== null && job.status !== "done" && job.status !== "error";

  const extract = useCallback(async () => {
    if (notes.trim().length === 0) return showToast("Paste some notes first");
    if (dirty.current && !window.confirm("Making a new map replaces the edits you made to the current one. Continue?")) {
      return;
    }
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes, model, granularity, map_type: mapType }),
    });
    const data = await res.json();
    if (data.error) return showToast(data.error);
    setJob({ status: "queued", progress: [] });
    poll(data.job_id);
  }, [notes, model, granularity, mapType, poll, showToast]);

  /* ---- editing ---- */
  const markDirty = () => {
    dirty.current = true;
  };

  const handleNodesChange = useCallback(
    (changes: NodeChange<AppNode>[]) => {
      if (changes.some((c) => c.type === "remove")) dirty.current = true;
      onNodesChange(changes);
    },
    [onNodesChange],
  );
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<AppEdge>[]) => {
      if (changes.some((c) => c.type === "remove")) dirty.current = true;
      onEdgesChange(changes);
    },
    [onEdgesChange],
  );

  const addNode = useCallback(
    (kind: string, position: { x: number; y: number }) => {
      let i = nextUid.current;
      while (rfNodes.some((n) => n.id === `u${i}`)) i++;
      nextUid.current = i + 1;
      const node: AppNode = {
        id: `u${i}`,
        type: "n2f",
        position,
        selected: true,
        data: { label: "New idea", kind, userAdded: true, unverified: false, provenance: null },
      };
      setRfNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node]);
      setRfEdges((es) => es.map((e) => ({ ...e, selected: false })));
      pendingFocus.current = true;
      markDirty();
    },
    [rfNodes, setRfNodes, setRfEdges],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      if (c.source === c.target) return showToast("A node can't connect to itself");
      if (rfEdges.some((e) => e.source === c.source && e.target === c.target && e.data?.relation === newRelation)) {
        return showToast("That arrow already exists");
      }
      const edge: AppEdge = {
        id: `ue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        source: c.source,
        target: c.target,
        data: { relation: newRelation, grounding: "explicit", label: null, status: "user_confirmed" },
      };
      setRfEdges((es) => [...es, edge]);
      markDirty();
    },
    [rfEdges, newRelation, setRfEdges, showToast],
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<NodeData>) => {
      setRfNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
      markDirty();
    },
    [setRfNodes],
  );
  const updateEdge = useCallback(
    (id: string, patch: Partial<EdgeData>) => {
      setRfEdges((es) =>
        es.map((e) =>
          e.id === id && e.data
            ? {
                ...e,
                data: {
                  ...e.data,
                  ...patch,
                  // A hand-edited arrow is the user's call, not the model's.
                  status: "user_confirmed",
                },
              }
            : e,
        ),
      );
      markDirty();
    },
    [setRfEdges],
  );
  const reverseEdge = useCallback(
    (id: string) => {
      setRfEdges((es) =>
        es.map((e) =>
          e.id === id && e.data
            ? { ...e, source: e.target, target: e.source, data: { ...e.data, status: "user_confirmed" } }
            : e,
        ),
      );
      markDirty();
    },
    [setRfEdges],
  );

  const selectedNodes = useMemo(() => rfNodes.filter((n) => n.selected), [rfNodes]);
  const selectedEdges = useMemo(() => rfEdges.filter((e) => e.selected), [rfEdges]);

  const deleteSelected = useCallback(() => {
    const gone = new Set(selectedNodes.map((n) => n.id));
    setRfNodes((ns) => ns.filter((n) => !n.selected));
    setRfEdges((es) => es.filter((e) => !e.selected && !gone.has(e.source) && !gone.has(e.target)));
    markDirty();
  }, [selectedNodes, setRfNodes, setRfEdges]);

  // Focus + select the label box right after adding a node.
  const singleNodeId = selectedNodes.length === 1 && selectedEdges.length === 0 ? selectedNodes[0]!.id : null;
  useEffect(() => {
    if (pendingFocus.current && singleNodeId && labelRef.current) {
      pendingFocus.current = false;
      labelRef.current.focus();
      labelRef.current.select();
    }
  }, [singleNodeId]);

  /* ---- folding (view-only) ---- */
  const topoKey = useMemo(
    () => JSON.stringify([rfNodes.map((n) => n.id), rfEdges.map((e) => [e.source, e.target])]),
    [rfNodes, rfEdges],
  );
  const foldInfo = useMemo(() => {
    const [ids, pairs] = JSON.parse(topoKey) as [string[], [string, string][]];
    return computeFold(ids, pairs, folded);
  }, [topoKey, folded]);

  const toggleIn = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const foldApi = useMemo<FoldApi>(
    () => ({
      toggleDetails: (id) => setOpenDetails((s) => toggleIn(s, id)),
      toggleBranch: (id) => setFolded((s) => toggleIn(s, id)),
    }),
    [],
  );
  const expandAll = useCallback(() => {
    setOpenDetails(new Set(rfNodes.filter((n) => (n.data.details?.length ?? 0) > 0).map((n) => n.id)));
    setFolded(new Set());
  }, [rfNodes]);
  // Fold every branching node: only the roots stay visible, and each + reveals one more layer.
  const collapseAll = useCallback(() => {
    setOpenDetails(new Set());
    setFolded(new Set(foldInfo.hasChildren));
  }, [foldInfo]);

  /* ---- layout, review, export (all driven by the edited canvas) ---- */
  const relayout = useCallback(async () => {
    const shown = rfNodes.filter((n) => !foldInfo.hidden.has(n.id));
    if (shown.length === 0) return;
    const positions = await fetchPositions(
      shown.map((n) => ({
        id: n.id,
        kind: n.data.kind,
        label: n.data.label,
        details: openDetails.has(n.id) ? n.data.details : undefined,
      })),
      rfEdges
        .filter((e) => !foldInfo.hidden.has(e.source) && !foldInfo.hidden.has(e.target))
        .map((e) => ({ from: e.source, to: e.target })),
      mapType,
    );
    setRfNodes((ns) => ns.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position })));
    setFitVersion((v) => v + 1);
  }, [rfNodes, rfEdges, setRfNodes, mapType, foldInfo, openDetails]);

  // Folding or opening a list changes the node sizes, so lay out again (not on the first render
  // and not when a fresh extraction just reset the fold state).
  const relayoutRef = useRef(relayout);
  relayoutRef.current = relayout;
  const foldMounted = useRef(false);
  useEffect(() => {
    if (!foldMounted.current) {
      foldMounted.current = true;
      return;
    }
    if (skipFoldRelayout.current) {
      skipFoldRelayout.current = false;
      return;
    }
    void relayoutRef.current();
  }, [folded, openDetails]);

  // Re-run the (free, rule-based) logic review after structural edits.
  const structureKey = useMemo(
    () =>
      JSON.stringify([
        rfNodes.map((n) => [n.id, n.data.label, n.data.kind]),
        rfEdges.map((e) => [e.source, e.target, e.data?.relation, e.data?.label]),
        mapType,
      ]),
    [rfNodes, rfEdges, mapType],
  );
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const nodesRef = useRef(rfNodes);
  nodesRef.current = rfNodes;
  const edgesRef = useRef(rfEdges);
  edgesRef.current = rfEdges;
  useEffect(() => {
    if (!dirty.current) return;
    const timer = window.setTimeout(async () => {
      if (nodesRef.current.length === 0) return setIssues([]);
      try {
        const res = await fetch("/api/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ graph: toGraph(nodesRef.current, edgesRef.current, graphRef.current, mapType) }),
        });
        const data = await res.json();
        if (Array.isArray(data.issues)) setIssues(data.issues);
      } catch {
        /* review is advisory; ignore transient failures */
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [structureKey]);

  const exportAs = useCallback(
    async (format: string) => {
      if (rfNodes.length === 0) return showToast("Nothing to export yet");
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graph: toGraph(rfNodes, rfEdges, graph, mapType), format }),
      });
      const data = await res.json();
      if (data.error) return showToast(data.error);
      const blob = new Blob([data.content], { type: data.mime });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `notes2flow.${data.ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    [rfNodes, rfEdges, graph, mapType, showToast],
  );

  const highlight = useCallback((targets: string[]) => setHighlightTargets(new Set(targets)), []);

  /* ---- render-time decoration (kept out of state so theme switches are instant) ---- */
  const nodesView = useMemo(
    () =>
      rfNodes.map((n): AppNode => {
        const highlighted = highlightTargets.has(n.id);
        const detailsOpen = openDetails.has(n.id);
        const hasChildren = foldInfo.hasChildren.has(n.id);
        const branchFolded = hasChildren && folded.has(n.id);
        const hiddenCount = foldInfo.hiddenCounts.get(n.id) ?? 0;
        const hidden = foldInfo.hidden.has(n.id);
        const d = n.data;
        if (
          (d.highlighted ?? false) === highlighted &&
          (d.detailsOpen ?? false) === detailsOpen &&
          (d.hasChildren ?? false) === hasChildren &&
          (d.branchFolded ?? false) === branchFolded &&
          (d.hiddenCount ?? 0) === hiddenCount &&
          (n.hidden ?? false) === hidden
        ) {
          return n;
        }
        return { ...n, hidden, data: { ...d, highlighted, detailsOpen, hasChildren, branchFolded, hiddenCount } };
      }),
    [rfNodes, highlightTargets, openDetails, folded, foldInfo],
  );
  const edgesView = useMemo<AppEdge[]>(
    () =>
      rfEdges.map((e): AppEdge => {
        const d = e.data;
        const stroke = e.selected ? t.accent : t.edge;
        return {
          ...e,
          hidden: foldInfo.hidden.has(e.source) || foldInfo.hidden.has(e.target),
          label: !d
            ? undefined
            : mapType === "process"
              ? d.label ?? undefined
              : `${REL_ARROW[d.relation] ?? "→"} ${d.relation}${d.grounding === "implied" ? " (implied)" : ""}`,
          labelStyle: { fill: t.ink, fontSize: 11 },
          labelBgStyle: { fill: t.labelBg, fillOpacity: 0.92 },
          style: {
            stroke: d?.status === "unverified" && !e.selected ? "#b45309" : stroke,
            strokeDasharray: d?.status === "unverified" ? "6 4" : undefined,
            strokeWidth: e.selected ? 2.6 : 1.6,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        };
      }),
    [rfEdges, t, mapType, foldInfo],
  );

  const stats = useMemo(() => {
    if (rfNodes.length === 0) return null;
    const mine = rfNodes.filter((n) => n.data.userAdded).length;
    const mineEdges = rfEdges.filter((e) => e.data?.status === "user_confirmed").length;
    const extractedNodes = rfNodes.filter((n) => !n.data.userAdded);
    const extractedEdges = rfEdges.filter((e) => e.data?.status !== "user_confirmed");
    const total = extractedNodes.length + extractedEdges.length;
    const verified =
      extractedNodes.filter((n) => !n.data.unverified).length +
      extractedEdges.filter((e) => e.data?.status !== "unverified").length;
    const prov = total > 0 ? ` · ${Math.round((verified / total) * 100)}% of extracted items provenance-verified` : "";
    const yours = mine + mineEdges > 0 ? ` · ${mine} nodes / ${mineEdges} arrows yours or confirmed by you` : "";
    return `${rfNodes.length} nodes · ${rfEdges.length} edges${prov}${yours}`;
  }, [rfNodes, rfEdges]);

  /* ---- inspector ---- */
  const inspector = (() => {
    if (singleNodeId) {
      const n = selectedNodes[0]!;
      const activeShape = n.data.shape ?? defaultShape(n.data.kind);
      return (
        <div className="inspector">
          <label className="field">
            <span>Label</span>
            <textarea
              ref={labelRef}
              rows={3}
              value={n.data.label}
              onChange={(e) => updateNode(n.id, { label: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Kind</span>
            <select value={n.data.kind} onChange={(e) => updateNode(n.id, { kind: e.target.value })}>
              {(kinds.includes(n.data.kind) ? kinds : [...kinds, n.data.kind]).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          {((n.data.details?.length ?? 0) > 0 || mapType === "process") && (
            <label className="field">
              <span>List items (one per line)</span>
              <textarea
                rows={Math.min(10, Math.max(3, (n.data.details?.length ?? 0) + 1))}
                value={(n.data.details ?? []).join("\n")}
                onChange={(e) => updateNode(n.id, { details: e.target.value.split("\n") })}
              />
            </label>
          )}
          <div className="field">
            <span>Shape</span>
            <div className="shape-row">
              {SHAPES.map((s) => (
                <button
                  key={s.id}
                  className={`shape-btn ${activeShape === s.id ? "active" : ""}`}
                  title={s.label}
                  onClick={() => updateNode(n.id, { shape: s.id })}
                >
                  {s.glyph}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>Color</span>
            <div className="swatch-row">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  className={`swatch ${n.data.color === c ? "active" : ""}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => updateNode(n.id, { color: c })}
                />
              ))}
              <input
                type="color"
                className="swatch-custom"
                title="Custom color"
                value={n.data.color ?? "#e8f0fe"}
                onChange={(e) => updateNode(n.id, { color: e.target.value })}
              />
            </div>
          </div>
          <div className="btn-row">
            <button
              className="btn small"
              onClick={() => updateNode(n.id, { shape: undefined, color: undefined })}
              disabled={!n.data.shape && !n.data.color}
            >
              Reset style
            </button>
            <button className="btn small danger" onClick={deleteSelected}>
              Delete node
            </button>
          </div>
        </div>
      );
    }
    if (selectedEdges.length === 1 && selectedNodes.length === 0) {
      const e = selectedEdges[0]!;
      const from = rfNodes.find((n) => n.id === e.source)?.data.label ?? e.source;
      const to = rfNodes.find((n) => n.id === e.target)?.data.label ?? e.target;
      return (
        <div className="inspector">
          <div className="edge-ends">
            <b>{from}</b> → <b>{to}</b>
          </div>
          <label className="field">
            <span>Label{mapType === "process" ? " (Yes / No / ...)" : ""}</span>
            <input
              type="text"
              value={e.data?.label ?? ""}
              onChange={(ev) => updateEdge(e.id, { label: ev.target.value || null })}
            />
          </label>
          <label className="field">
            <span>Relation</span>
            <select value={e.data?.relation} onChange={(ev) => updateEdge(e.id, { relation: ev.target.value })}>
              {RELATIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Grounding</span>
            <select value={e.data?.grounding} onChange={(ev) => updateEdge(e.id, { grounding: ev.target.value })}>
              <option value="explicit">explicit</option>
              <option value="implied">implied</option>
            </select>
          </label>
          <div className="btn-row">
            <button className="btn small" onClick={() => reverseEdge(e.id)}>
              Reverse direction
            </button>
            <button className="btn small danger" onClick={deleteSelected}>
              Delete arrow
            </button>
          </div>
        </div>
      );
    }
    if (selectedNodes.length + selectedEdges.length > 1) {
      return (
        <div className="inspector">
          <div className="stats">
            {selectedNodes.length} nodes and {selectedEdges.length} arrows selected.
          </div>
          <div className="btn-row">
            <button className="btn small danger" onClick={deleteSelected}>
              Delete selected
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="stats hint">
        Click a node or arrow to edit it. Drag from a node's bottom dot to another node's top dot to draw an arrow. Press
        Delete to remove the selection. Shift-drag to select several.
      </div>
    );
  })();

  return (
    <div className="app">
      <header className="header">
        <h1>Notes2Flow</h1>
        <select value={model} onChange={(e) => setModel(e.target.value)} title="Model">
          <option value="z-ai/glm-5.3-flash">GLM 5.3 Flash (cheap)</option>
          <option value="anthropic/claude-sonnet-5.5">Claude Sonnet 5.5</option>
        </select>
        <select
          value={mapType}
          onChange={(e) => setMapType(asMapType(e.target.value))}
          title="What kind of map to make: an idea map of claims and options, or a process flowchart of steps and decisions"
        >
          {(Object.keys(MAP_TYPE_LABELS) as MapType[]).map((mt) => (
            <option key={mt} value={mt}>
              {MAP_TYPE_LABELS[mt]}
            </option>
          ))}
        </select>
        <select value={granularity} onChange={(e) => setGranularity(e.target.value)} title="Detail level">
          <option value="low">Compact</option>
          <option value="medium">Thorough</option>
          <option value="high">Exhaustive</option>
        </select>
        <button className="btn primary" onClick={extract} disabled={busy}>
          {busy ? "Working…" : "Make the map"}
        </button>
        <div className="grow" />
        <label className="toolbar-label" title="Visual design">
          Design
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            {Object.entries(THEMES).map(([id, def]) => (
              <option key={id} value={id}>
                {def.label}
              </option>
            ))}
          </select>
        </label>
        <label className="toolbar-label" title="Font">
          Font
          <select value={font} onChange={(e) => setFont(e.target.value)}>
            {Object.entries(FONTS).map(([id, def]) => (
              <option key={id} value={id}>
                {def.label}
              </option>
            ))}
          </select>
        </label>
        <span className="toolbar-sep" />
        <button className="btn" onClick={relayout} disabled={rfNodes.length === 0}>
          Re-layout
        </button>
        <button className="btn" onClick={collapseAll} disabled={rfNodes.length === 0} title="Fold every branch; click + on a node to reveal the next layer">
          Collapse all
        </button>
        <button className="btn" onClick={expandAll} disabled={rfNodes.length === 0} title="Show every node and every list">
          Expand all
        </button>
        <button className="btn" onClick={() => exportAs("mermaid")} disabled={rfNodes.length === 0}>
          Mermaid
        </button>
        <button className="btn" onClick={() => exportAs("excalidraw")} disabled={rfNodes.length === 0}>
          Excalidraw
        </button>
        <button className="btn" onClick={() => exportAs("json")} disabled={rfNodes.length === 0}>
          JSON
        </button>
      </header>

      <div className="panel notes-panel">
        <h2>Your notes (Markdown)</h2>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="stats">{stats ?? "Paste notes, then press Make the map. Or add nodes by hand on the canvas."}</div>
      </div>

      <div className="canvas-area">
        <FoldContext.Provider value={foldApi}>
        <ReactFlow
          nodes={nodesView}
          edges={edgesView}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          colorMode={t.dark ? "dark" : "light"}
          deleteKeyCode={["Backspace", "Delete"]}
          multiSelectionKeyCode="Shift"
          connectionRadius={36}
          minZoom={0.1}
          zoomOnDoubleClick={false}
        >
          <Background gap={22} color={t.grid} />
          <Controls showInteractive={false} />
          <EditorToolbar
            kinds={kinds}
            kind={newKind}
            setKind={setNewKind}
            relation={newRelation}
            setRelation={setNewRelation}
            onAdd={addNode}
          />
          <FitController version={fitVersion} />
        </ReactFlow>
        </FoldContext.Provider>
        {rfNodes.length === 0 && (
          <div className="empty-state">
            Your {mapType === "process" ? "process map" : "idea map"} will appear here.
            <br />
            Make it from your notes, or start by hand with “+ Add node”.
          </div>
        )}
        {job && job.status !== "done" && job.status !== "error" && (
          <div className="toast">
            {job.status}: {(job.progress ?? []).slice(-1)[0] ?? ""}
          </div>
        )}
        {toast && <div className="toast">{toast}</div>}
      </div>

      <div className="panel review-panel">
        <h2>Selection</h2>
        {inspector}
        <h2 style={{ marginTop: 18 }}>Logic review</h2>
        {issues.length === 0 && rfNodes.length > 0 && <div className="stats">No findings. Clean map.</div>}
        {issues.length === 0 && rfNodes.length === 0 && <div className="stats">Run an extraction to see findings.</div>}
        {issues.map((issue, i) => (
          <div key={i} className={`issue ${issue.severity}`} onClick={() => highlight(issue.targets)}>
            {issue.message}
            <div className="targets">{issue.targets.join(" · ")}</div>
          </div>
        ))}
        <h2 style={{ marginTop: 18 }}>Legend</h2>
        <div className="legend">
          {kinds.map((k) => (
            <span key={k} style={{ background: `var(--kind-${k})` }}>
              {k}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

export default App;
